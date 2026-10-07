// test/promptCitations.test.js — docs/prompts/*.md 里的每一处代码引用都必须**真的指得到**。
//
// 这几份文档是创作者（与人、与 AI）写第一份内容的唯一依据，而它们靠**手写的 `文件:行号`** 把读者带到引擎的真实现场。
// 上游基线一换、引擎一挪行号，文档就变成「看起来很具体、点进去是别的东西」——这种腐烂不会有任何东西报错，
// 只有照着它做的人会踩空（0.8.2 移植时就抓到两处：`server/sim/lifecycle.js` 少了 `battle/` 一层、
// `kits/tier1.js` 少了 `shared/` 一层）。所以这里把它当门禁：
//   ① 带 `:行号` 的引用：文件要在、行号要在范围内、被指的那一行要有内容（不是空行或孤零零的括号）；
//   ② 不带行号的文件引用：只要它以仓库的顶层目录开头（server/ shared/ public/ …），就必须真的存在。
// 引用的事实对不对（那一行是不是真在做文档说的事）判不了，那要靠人；能判的是「点进去有没有东西」。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/prompts');
const FILES = readdirSync(DIR).filter((n) => n.endsWith('.md')).sort();

/** 仓库里真实存在的顶层目录：只有这些开头的裸引用才当作「应该存在」。 */
const TOP_DIRS = ['server/', 'shared/', 'public/', 'tools/', 'docs/', 'editor/', 'test/', 'scripts/'];

const CITATION = /`([A-Za-z0-9_./-]+\.(?:js|mjs|json|md|css|html)):(\d+)(?:-(\d+))?`/g;
const BARE = /[A-Za-z0-9_./-]+\.(?:js|mjs|json|md|css|html)/g;

const lines = (rel) => readFileSync(join(ROOT, rel), 'utf8').split('\n');

describe('docs/prompts 的代码引用（点进去必须有东西）', () => {
  test('每个 `文件:行号` 引用都存在、行号在范围内、那一行有内容', () => {
    assert.ok(FILES.length >= 3, `docs/prompts 下应当有几份 prompt，实际找到 ${FILES.length} 份`);
    const bad = [];
    let total = 0;
    for (const name of FILES) {
      const text = readFileSync(join(DIR, name), 'utf8');
      for (const m of text.matchAll(CITATION)) {
        const [, rel, from, to] = m;
        total += 1;
        const docLine = text.slice(0, m.index).split('\n').length;
        if (!existsSync(join(ROOT, rel))) {
          bad.push(`${name}:${docLine} 引用的 ${rel} 不存在`);
          continue;
        }
        const src = lines(rel);
        if (Number(to ?? from) > src.length) {
          bad.push(`${name}:${docLine} 引用的 ${rel}:${to ?? from} 超出范围（该文件只有 ${src.length} 行）`);
          continue;
        }
        const cited = src[Number(from) - 1].trim();
        // 指向空行 / 只有括号的行 = 行号漂了，读者点进去看不到文档在说的东西
        if (!cited || /^[)}\]);,]+$/.test(cited)) {
          bad.push(`${name}:${docLine} 引用的 ${rel}:${from} 那一行是空的（行号漂了）`);
        }
      }
    }
    assert.ok(total > 100, `引用数量看起来不对（只有 ${total} 处）—— 正则是不是失效了？`);
    assert.deepEqual(bad, [], '这些引用点不到东西：\n' + bad.join('\n'));
  });

  test('以仓库顶层目录开头的裸引用（不带行号的那些）也必须存在', () => {
    const bad = [];
    for (const name of FILES) {
      const text = readFileSync(join(DIR, name), 'utf8');
      const seen = new Set();
      for (const m of text.matchAll(BARE)) {
        const rel = m[0].replace(/^\.\//, '');
        if (!TOP_DIRS.some((d) => rel.startsWith(d))) continue;
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!existsSync(join(ROOT, rel))) bad.push(`${name}: ${rel}`);
      }
    }
    assert.deepEqual(bad, [], '这些路径不存在：\n' + bad.join('\n'));
  });
});
