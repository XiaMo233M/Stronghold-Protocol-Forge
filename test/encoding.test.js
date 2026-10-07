// test/encoding.test.js — 编码卫生：仓库里的文本文件**必须**是干净的 UTF-8。
//
// 为什么值得一条测试：这个仓库的注释、文档、界面文案与**用户可见的错误信息**大量是中文，而开发环境是中文 Windows +
// PowerShell —— 一条 `Get-Content … | Set-Content …` 就能把 UTF-8 当成 GBK 读一遍再写回去，把整份文件的中文变成
// 乱码（还会顺手吃掉换行、写出 BOM），而且**编辑器与游戏都不会报错**：只是文案变成一串看不懂的汉字。
// 真发生过一次（2026-10-07，`editor/server.mjs`），所以这里把它钉成门禁的一部分：
//   * 任何文本文件里出现 U+FFFD（替换字符）或 BOM，都是这一事故的指纹；
//   * 几个中英混排的关键文件里必须还能读到指定的中文片段 —— 乱码会把它们打散，这条能抓住没有 U+FFFD 的
//     那些「静默乱码」（例如 CP936 把「。」读成「銆嶇」这类看起来仍像汉字的东西）。
//
// 只读、只扫文本扩展名；素材目录（图片/音频/字体）与 node_modules 不在其列。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 素材、依赖与构建产物：里面不是文本，或是别处的副本。 */
const SKIP = new Set(['node_modules', '.git', 'assets', 'vendor', 'fonts', 'dist', 'coverage', '.cache', 'out']);
const EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml']);

/** 每个文本文件的相对路径。 */
function textFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (EXTS.has(path.extname(e.name)) && !e.name.endsWith('.min.js')) out.push(p);
    }
  };
  walk(ROOT);
  return out.sort();
}

/** 中英混排的关键文件里必须读得到的中文（乱码会把它们打散）。 */
const CANARIES = [
  ['docs/WORKSHOP.md', '工坊'],
  ['docs/EDITOR.md', '编辑器'],
  ['shared/constants.js', '配音'],
  ['editor/ui/voice.js', '配音'],
  ['editor/ui/item.js', '图标'],
  ['editor/server.mjs', '不合法'],
  ['server/match/player/economy.js', '空位'],
  ['CHANGELOG.md', '更新记录'],
];

describe('编码卫生（UTF-8 不能被当成 GBK 读一遍）', () => {
  const files = textFiles();

  test('仓库里扫得到文本文件（这条测试自己不是空转）', () => {
    assert.ok(files.length > 500, `扫到 ${files.length} 个文本文件`);
  });

  test('没有替换字符 U+FFFD，也没有 BOM', () => {
    const bad = [];
    for (const p of files) {
      const text = fs.readFileSync(p, 'utf8');
      const at = text.indexOf('\uFFFD');
      if (at >= 0) {
        const line = text.slice(0, at).split('\n').length;
        bad.push(`${path.relative(ROOT, p)}:${line} 含 U+FFFD`);
      }
      if (text.charCodeAt(0) === 0xFEFF) bad.push(`${path.relative(ROOT, p)}:1 以 BOM 开头`);
    }
    assert.deepEqual(bad, [], 'U+FFFD/BOM 是「UTF-8 被当成 GBK 往返」的指纹');
  });

  test('关键文件里的中文片段还在（没有 U+FFFD 的静默乱码也会被抓到）', () => {
    for (const [rel, needle] of CANARIES) {
      const p = path.join(ROOT, rel);
      assert.ok(fs.existsSync(p), `${rel} 应当存在`);
      assert.ok(fs.readFileSync(p, 'utf8').includes(needle), `${rel} 里读不到「${needle}」`);
    }
  });
});
// 关于换行：不在这里断言 LF。仓库没有 LF 政策，`tools/local-extract/` 那两个上游自带的文件
// （Ark-Unpacker 的 LICENSE 与 requirements）本来就是 CRLF，逼它们改成 LF 只会平白造一次 diff。
// 真被 Windows 往返改掉换行时，`git status` 会在提交前就看得见 —— 那比一条测试更直接。
