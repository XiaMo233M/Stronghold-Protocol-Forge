// test/helpers/changelog.js — 更新记录作为**一份文本**，给那些钉它句子的测试用。
//
//   import { changelogText, changelogSections } from '../helpers/changelog.js';
//   const LOG = changelogText(ROOT);   // 顶层（索引 + 最近 8 节）在前，然后按大版本各分卷
//
// `CHANGELOG.md` 自 2026-10-12 起是**索引 + 最近 8 节**：更早的按大版本分卷在 `docs/changelog/*.md`，每一节
// （它的 `## x.y.z — 日期` 标题与正文）**逐字节**住在其中一处，一处只有一份。`changelogText()` 把两边拼起来，
// 给「0.1.0 还在册」「0.1.1 记了这两条 PR」这类**跨节**断言用 —— 断言原文一个字都不用改，只换读取路径。
//
// **切点由公告定，不由体积定**：顶层那一段必须仍能让 `server/notices.js` 发满 `NOTICE_LIMITS.announcements`
// 条公告，否则游戏内公告会**静默变少**。钉它的是 `test/docs-paths.test.js` 那条守卫与
// `test/packNotices.test.js` 的「更新记录最上面那一节一定在公告里」。
//
// ⚠️ **凡直读顶层 `CHANGELOG.md` 的消费者都要跟着改** —— 这是分卷唯一的坑，2026-10-12 真踩过：
// 顶层只剩最近 8 节，老节搬进了 `docs/changelog/`，所以一个 `readFileSync('CHANGELOG.md')` 再
// `slice('## 0.1.1', '## 0.1.0')` 的测试会拿到**空串**（断言空转失败）。要老节就用这里的 `changelogText()`。
// 找它们要**递归**扫：`git grep -n CHANGELOG -- test tools server` —— 只扫 `test/*.js` 会漏掉
// `test/match/` 这种子目录（`test/match/feedback1-gaps.test.js` 就是这么漏的）；而且**定向跑测试不会红，
// 只有全量会** —— 所以改这种「搬移内容 / 改读取路径」的活，落地前必须跑一次全量。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 分卷目录：顶层之外的节都住在这里。 */
export const CHANGELOG_DIR = 'docs/changelog';

/** 一节的标题形状：发行 tag 会把上游版本挂在后面（`## 0.16.0-0.2.4 — 2026-10-12`）。 */
const SECTION_RE = /^## (\d+\.\d+\.\d+(?:-\d+\.\d+\.\d+)?) — (\d{4}-\d{2}-\d{2})[^\S\n]*$/gm;

/** 一份更新记录文本里的节（`release` 保留 `-<上游>` 那半边 —— 两节可以只差它）。 */
export function changelogSections(text) {
  return [...text.matchAll(SECTION_RE)].map((m) => ({ release: m[1], date: m[2] }));
}

/** 分卷文件名（`0.9.md` … `0.13.md`），按大版本**从新到旧**排 —— 与顶层那一段接得上。 */
export function changelogVolumeFiles(root) {
  const dir = join(root, CHANGELOG_DIR);
  if (!existsSync(dir)) return [];
  const key = (f) => f.replace(/\.md$/, '').split('.').map(Number);
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .sort((a, b) => { const [x, y] = [key(a), key(b)]; return (y[0] - x[0]) || (y[1] - x[1]); });
}

/** 更新记录作为一份文本：顶层在前，然后各分卷（新 → 旧）。 */
export function changelogText(root) {
  const parts = [readFileSync(join(root, 'CHANGELOG.md'), 'utf8')];
  for (const f of changelogVolumeFiles(root)) parts.push(readFileSync(join(root, CHANGELOG_DIR, f), 'utf8'));
  return parts.join('\n');
}
