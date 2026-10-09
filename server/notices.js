// server/notices.js — 公告与鸣谢这一层**载体**（DESIGN §28.15，业主 2026-10-10 的 G5）。
//
// (i18n-ignore-file: 这个文件里没有界面文案，只有**内容** —— 引擎的鸣谢名单与从 `CHANGELOG.md` 生成的公告正文，
//  与 `data/*.json` 的游戏文本、更新记录本身同一类东西（项目源语言写的内容，不是可以逐键翻译的界面词）。
//  界面那一半（面板标题、「关闭」按钮）属于客户端模块，那里照常走 `t()`。要让公告正文本身多语，正路是把它接进
//  `data/i18n/` 那条通道 —— 那是后续的一刀，不是把这几句塞进语言包。)
//
// 这一格缺的**先是产品面**：仓库里根本没有「公告」这个载体的任何形态（没有 `announcementData.js`、没有生成器、
// 登录页也没有这两个面板）。所以第一件事是让载体存在 —— 而它的**引擎那一半不手写**：公告从 `CHANGELOG.md` 生成
// （单一事实源：更新记录写在哪，公告就是什么），鸣谢来自引擎自己的名单加各包声明的署名表。
//
// 包那一半（`pack.json.notices`）是**追加**语义：一个包一条自己的公告、一张自己的署名表。它不会顶掉引擎的公告，
// 也不会顶掉别的包的 —— 两个包的公告不冲突，所以这里没有「谁赢」的问题（与 `i18n` 的逐键覆盖刻意不同）。

import fs from 'node:fs';
import path from 'node:path';

/** 合并体最多带几条公告 / 几条署名（端点会送到每个浏览器，必须有界）。 */
export const NOTICE_LIMITS = Object.freeze({ announcements: 8, credits: 40, sections: 12, items: 40, itemChars: 200, summaryChars: 600 });
/** 引擎自己的鸣谢（项目、上游、素材权利方）——**唯一**一份，写在代码里而不是某个 `.json` 里。 */
const ENGINE_CREDITS = Object.freeze([
  { name: 'Stronghold-Protocol-Forge', note: '本仓库（工坊编辑器 + 引擎侧改动）', url: 'https://github.com/XiaMo233M/Stronghold-Protocol-Forge' },
  { name: 'sganggs/Stronghold-Protocol', note: '上游同人游戏本体', url: 'https://github.com/sganggs/Stronghold-Protocol' },
  { name: '上海鹰角网络 / Yostar', note: '《明日方舟》及「卫戍协议」相关素材的版权方 —— 本项目与其无任何关系，素材仅限非商业使用' },
]);

/** 一条要展示给人看的文本：去掉多余空白、有长度上限（`null` = 这一条不能用）。 */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * 从 `CHANGELOG.md` 生成公告（**引擎自己的那一份**，单一事实源）。
 *
 * 认的形状就是这份文件自己的形状：`## <version> — <date>` 一节，节内第一段是摘要，`### <名字>` 是小节，
 * 小节里的 `- ` 行是条目（续行按缩进并入上一条）。不认识的写法**跳过**而不是猜 —— 公告是展示用的，
 * 猜错比少一条难查得多。
 * @param {{ changelogPath: string, limit?: number }} opts
 * @returns {Array<{ version: string, date: string, summary: string, sections: Array<{ name: string, items: string[] }> }>}
 */
export function engineAnnouncements({ changelogPath, limit = NOTICE_LIMITS.announcements } = {}) {
  let text;
  try { text = fs.readFileSync(changelogPath, 'utf8'); } catch { return []; }
  const lines = text.split(/\r?\n/);
  /** @type {Array<any>} */
  const out = [];
  /** @type {any} */
  let cur = null;
  /** @type {any} */
  let section = null;
  const flushSection = () => {
    if (cur && section && section.items.length) cur.sections.push(section);
    section = null;
  };
  const flushRelease = () => {
    flushSection();
    if (!cur) return;
    if (cur.summary && cur.sections.length && out.length < limit) out.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const release = /^##\s+(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (release) {
      flushRelease();
      cur = { version: release[1], date: release[2], summary: '', sections: [] };
      continue;
    }
    if (!cur) continue;
    const head = /^###\s+(.+?)\s*$/.exec(line);
    if (head) {
      flushSection();
      const name = cleanText(head[1], 80);
      section = name ? { name, items: [] } : null;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) { flushRelease(); continue; }   // 下一个 `#` 顶层标题：结束
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item && section) {
      if (section.items.length >= NOTICE_LIMITS.items) continue;
      const body = cleanText(item[1], NOTICE_LIMITS.itemChars);
      if (body) section.items.push(body);
      continue;
    }
    if (/^\s+\S/.test(line) && section && section.items.length) {
      // 缩进的续行：并入上一条（更新记录里长条目就是折行的）
      const joined = cleanText(`${section.items[section.items.length - 1]} ${line}`, NOTICE_LIMITS.itemChars);
      if (joined) section.items[section.items.length - 1] = joined;
      continue;
    }
    if (section) continue;
    if (!cur.summary) {
      const body = cleanText(line, NOTICE_LIMITS.summaryChars);
      if (body) cur.summary = body;
    }
  }
  flushRelease();
  return out;
}

/** 引擎那一半：公告（从更新记录生成）+ 鸣谢（代码里的名单）。 */
export function engineNotices({ changelogPath, limit = NOTICE_LIMITS.announcements } = {}) {
  return {
    announcements: engineAnnouncements({ changelogPath, limit }).map((a) => ({ ...a, pack: null })),
    credits: ENGINE_CREDITS.map((c) => ({ ...c })),
  };
}

/** 读一个包内相对 `.json`（`null` = 读不出来或不是 JSON）。 */
function readPackJson(packDir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(packDir, ...String(rel).split('/')), 'utf8')); } catch { return null; }
}

/**
 * 装载期判据：声明的两个 `.json` 必须真的在包里、可读、是 JSON。与 `i18nIssues` / `metaIssues` 同一条纪律 ——
 * 一份读不出来的公告如果只是被跳过，作者会以为公告**发出去了**，而登录页上什么都没有。
 * @param {{ notices?: { announcement?: string, credits?: string } }|null} pack
 * @param {string} packDir
 * @returns {Array<{ code: string, reason: string }>}
 */
export function noticesIssues(pack, packDir) {
  const decl = pack && pack.notices;
  if (!decl || typeof packDir !== 'string' || !packDir) return [];
  const dir = path.resolve(packDir);
  for (const field of ['announcement', 'credits']) {
    const rel = decl[field];
    if (typeof rel !== 'string' || !rel) continue;
    const abs = path.join(dir, ...rel.split('/'));
    if (abs === dir || !abs.startsWith(dir + path.sep)) {
      return [{ code: 'NOTICES_BAD_PATH', reason: `notices.${field} "${rel}" must resolve inside the pack` }];
    }
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch {
      return [{ code: 'NOTICES_BAD_FILE', reason: `notices.${field} "${rel}" is declared in pack.json but is not a readable file inside the pack` }];
    }
    try { JSON.parse(raw); } catch (e) {
      return [{ code: 'NOTICES_BAD_FILE', reason: `notices.${field} "${rel}" is not valid JSON: ${e && e.message ? e.message : e}` }];
    }
  }
  return [];
}

/**
 * 把引擎与各包的纯文本合成**一份**合并体（`/data/notices.json` 的正文）。
 *
 * 一个包的声明不合形状（公告不是对象、条目不是字符串、网址不是 https、超上限）时：**跳过这一条并点名**，
 * 其余照旧 —— 与 `i18n` 的「一份坏译文不让整包消失」不同，这里的坏值不会影响别的包，所以不必连坐。
 * @param {{ packs?: Array<{ id: string, dir?: string, notices?: object }> }} loaded
 * @param {{ changelogPath: string, log?: any }} opts
 * @returns {{ body: { announcements: any[], credits: any[] }, errors: Array<{ pack: string, field: string, code: string, reason: string }> }}
 */
export function workshopNotices(loaded, { changelogPath, log = null } = {}) {
  const engine = engineNotices({ changelogPath });
  /** @type {any[]} */
  const announcements = [...engine.announcements];
  /** @type {any[]} */
  const credits = [...engine.credits];
  /** @type {Array<{ pack: string, field: string, code: string, reason: string }>} */
  const errors = [];
  const packs = (loaded && Array.isArray(loaded.packs) ? loaded.packs : [])
    .filter((p) => p && p.notices)
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const seenCredit = new Set(credits.map((c) => `${c.name}|${c.url || ''}`));
  for (const pack of packs) {
    const dir = pack.dir || '';
    if (pack.notices.announcement) {
      const raw = dir ? readPackJson(dir, pack.notices.announcement) : null;
      const bad = !raw || typeof raw !== 'object' || Array.isArray(raw);
      if (bad) {
        errors.push({ pack: pack.id, field: 'announcement', code: 'NOTICES_BAD_VALUE', reason: `notices.announcement "${pack.notices.announcement}" must be a JSON object { version, date, summary, sections }` });
      } else {
        const version = cleanText(raw.version, 32);
        const date = cleanText(raw.date, 32);
        const summary = cleanText(raw.summary, NOTICE_LIMITS.summaryChars);
        /** @type {Array<{ name: string, items: string[] }>} */
        const sections = [];
        for (const section of Array.isArray(raw.sections) ? raw.sections.slice(0, NOTICE_LIMITS.sections) : []) {
          if (!section || typeof section !== 'object') continue;
          const name = cleanText(section.name, 80);
          const items = (Array.isArray(section.items) ? section.items : [])
            .map((item) => cleanText(item, NOTICE_LIMITS.itemChars)).filter(Boolean).slice(0, NOTICE_LIMITS.items);
          if (name && items.length) sections.push({ name, items });
        }
        if (!version || !date || !summary) {
          errors.push({ pack: pack.id, field: 'announcement', code: 'NOTICES_BAD_VALUE', reason: 'notices.announcement needs a non-empty version, date and summary (a release note without them is not something the panel can show)' });
        } else {
          announcements.push({ pack: pack.id, version, date, summary, sections });
        }
      }
    }
    if (pack.notices.credits) {
      const raw = dir ? readPackJson(dir, pack.notices.credits) : null;
      if (!Array.isArray(raw)) {
        errors.push({ pack: pack.id, field: 'credits', code: 'NOTICES_BAD_VALUE', reason: `notices.credits "${pack.notices.credits}" must be a JSON array of { name, note?, url? }` });
      } else {
        for (const entry of raw) {
          if (credits.length >= NOTICE_LIMITS.credits) {
            errors.push({ pack: pack.id, field: 'credits', code: 'NOTICES_TOO_MANY', reason: `the merged credits already hold ${NOTICE_LIMITS.credits} entries — the rest are dropped` });
            break;
          }
          const name = entry && typeof entry === 'object' ? cleanText(entry.name, 80) : null;
          const note = entry && typeof entry === 'object' ? cleanText(entry.note, 200) : null;
          const url = entry && typeof entry === 'object' ? cleanText(entry.url, 300) : null;
          if (!name) {
            errors.push({ pack: pack.id, field: 'credits', code: 'NOTICES_BAD_VALUE', reason: 'every credits entry needs a non-empty name' });
            continue;
          }
          if (url && !/^https:\/\//.test(url)) {
            errors.push({ pack: pack.id, field: 'credits', code: 'NOTICES_BAD_URL', reason: `credits entry "${name}": url "${url}" must start with https:// (a page that links out must not be able to reach a local scheme)` });
            continue;
          }
          const key = `${name}|${url || ''}`;
          if (seenCredit.has(key)) continue;
          seenCredit.add(key);
          credits.push({ pack: pack.id, name, ...(note ? { note } : {}), ...(url ? { url } : {}) });
        }
      }
    }
  }
  // 上限落在**合并体**上，而引擎自己就可能正好有 cap 条 —— 那样每个包的一条都会被挤掉。规则说清楚：**玩家还没看过
  // 的一条包公告，比引擎更旧的那几条更该被看到**（旧版说明在 `CHANGELOG.md` 里永远查得到）。所以超出上限时丢的是
  // **引擎那一端最旧**的几条：引擎条目按新→旧排在前面，`engineEnd` 是第一条包公告的位置，从 `engineEnd - drop`
  // 起删就是删最旧的引擎条目。丢的是引擎自己的数据，所以不报错（没有任何一条包写的被丢掉）。
  const firstPack = announcements.findIndex((a) => a.pack !== null);
  const engineEnd = firstPack < 0 ? announcements.length : firstPack;
  const overflow = announcements.length - NOTICE_LIMITS.announcements;
  if (overflow > 0 && engineEnd > 0) announcements.splice(engineEnd - Math.min(overflow, engineEnd), Math.min(overflow, engineEnd));
  if (announcements.length > NOTICE_LIMITS.announcements) announcements.length = NOTICE_LIMITS.announcements;
  for (const e of errors) log?.warn?.(`[workshop] notices ${e.pack}: ${e.code}: ${e.reason}`);
  return { body: { announcements, credits }, errors };
}
