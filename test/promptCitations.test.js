// test/promptCitations.test.js — 文档里的每一处代码引用都必须**真的指得到**。
//
// 这几份文档是创作者（与人、与 AI）写第一份内容的唯一依据，而它们靠**手写的 `文件:行号`** 把读者带到引擎的真实现场。
// 上游基线一换、引擎一挪行号，文档就变成「看起来很具体、点进去是别的东西」——这种腐烂不会有任何东西报错，
// 只有照着它做的人会踩空（0.8.2 移植时就抓到两处：`server/sim/lifecycle.js` 少了 `battle/` 一层、
// `kits/tier1.js` 少了 `shared/` 一层）。所以这里把它当门禁：
//   ① 带 `:行号` 的引用：文件要在、行号要在范围内、被指的那一行要有内容（不是空行或孤零零的括号）；
//   ② 不带行号的文件引用：只要它以仓库的顶层目录开头（server/ shared/ public/ …），就必须真的存在。
// 引用的事实对不对（那一行是不是真在做文档说的事）判不了，那要靠人；能判的是「点进去有没有东西」。
//
// **覆盖面 2026-10 扩过一次（`docs/prompts` → 加上 `docs/design`）**：原来只扫 `docs/prompts`，于是
// `docs/design/mod-layer.md` 里那 **162 处**手写 `文件:行号` **完全在门禁外** —— 而它偏偏是漂移面最大的一份
// （0.16.0 那一刀就手工重指过 28 处）。这正是「引用会烂而没人知道」的根因：判据存在，但没看着那一份。
//
// 扩完当场报 19 处，逐条查下来是**两类**，而且一半以上不是文档的错：
//   * **10 处文档真错**（`docs/design/mod-layer.md` 9 处 + `overview.md` 1 处）：按**内容**重指到那一行现在真的
//     在哪（不是加偏移）—— 例：`docs/WORKSHOP.md` 那张「未实现」表从 `:447` 挪到了 `:597`；`KIT_ID_COLLISION`
//     从 `server/workshop.js:392` 挪到了 `:1229`；`this.flags` 从 `Battle.js:124` 挪到了 `:149`。
//   * **9 处判据自己的假红**：4 处是**扩展名顺序**（`js` 排在 `json` 前 ⇒ `….json` 被读成 `….js`；见下面 `CITATION`
//     那一段注释）、5 处是**包内路径**被当成仓库路径（§28.14/§28.15 引的社区包自己的 `server/ops.js` 等；
//     见 `PACK_INTERNAL_PATHS`）。判据修对了，这 9 处一条文档都没改。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 扫哪些目录。`docs/prompts` 是创作者照抄的唯一依据；`docs/design` 是规则本身、也是手写行号最多的一份。
 * 两个都要看 —— 只扫前者时后者那 162 处引用无人看守（见文件头）。
 */
const DIRS = ['docs/prompts', 'docs/design'];
/** 每份文档的**仓库相对路径**（报告里的 `name` 就是它），稳定排序。 */
const FILES = DIRS
  .flatMap((d) => readdirSync(join(ROOT, d)).filter((n) => n.endsWith('.md')).map((n) => `${d}/${n}`))
  .sort();

/** 仓库里真实存在的顶层目录：只有这些开头的裸引用才当作「应该存在」。 */
const TOP_DIRS = ['server/', 'shared/', 'public/', 'tools/', 'docs/', 'editor/', 'test/', 'scripts/'];

// ⚠️ **扩展名的顺序有意义**：把 `js` 写在 `json` 前面时，正则会在 `…spines.json` 上先吃掉 `.js` 就收工 ——
// 于是 `.json` 的文件被读成 `.js` 的文件，门禁凭空报「不存在」（扩到 docs/design 那天实测 4 处假红）。
// 长的排前面，这条陷阱就没了。
const CITATION = /`([A-Za-z0-9_./-]+\.(?:json|mjs|js|md|css|html)):(\d+)(?:-(\d+))?`/g;
const BARE = /[A-Za-z0-9_./-]+\.(?:json|mjs|js|md|css|html)/g;

const lines = (rel) => readFileSync(join(ROOT, rel), 'utf8').split('\n');

/**
 * 装出来 / git 忽略的东西：新检出里本来就没有它，要求它「存在」是错的（与 `test/docs-paths.test.js` 同一份名单）。
 * `public/assets/` 是 `npm run setup` 下载的、`.gitignore` 挡着的（AGENTS.md「No game art in git」）。
 */
const NOT_IN_A_FRESH_CHECKOUT = ['public/assets/', 'public/vendor/', 'data/local-assets.json'];

/**
 * **看起来像本仓库的路径、其实不是。** 这几条是**包内**的文件名 —— 社区包自己的 `server/ops.js`、
 * `server/stats.js`、`server/healthz.js`（§28.14 引它们说明「包的哪些改动这一层表达不了」）、
 * 包自己的 `public/js/ui/announcementData.js`（§28.15），以及 §28.2 举的「包目录里没人声明的文件」
 * （`server/rules.mjs`）。判据看不出「这个字符串属于谁」，所以逐条列出来。
 *
 * **这份名单只许放这种** —— 不许拿它藏本仓库的真路径；门禁的牙在「真路径必须存在」那一半。
 * 下面有一条测试核「名单里每一条仍然出现在被扫的文档里」，所以它不会烂在这里。
 */
const PACK_INTERNAL_PATHS = Object.freeze([
  'server/rules.mjs',
  'server/ops.js',
  'server/stats.js',
  'server/healthz.js',
  'public/js/ui/announcementData.js',
]);

// ---- 「点进去是别的东西」的判据（见下面那条测试的注释：窄，宁可漏不可误报）-----------------------------------------
/** 只判这五个引擎语境的根，值 = 该根允许离引用多远（字符）。 */
const CLAIM_ROOTS = Object.freeze({ battle: 45, this: 45, flags: 90, bb: 45, ctx: 45 });
/** 带点的成员引用：`battle.flags`、`flags.layerGainsEnabled`、`bb.atk`。 */
const DOTTED = /`([A-Za-z_$][\w$]*(?:\.[\w$]+)+)`/g;
/** 以这些结尾的不是成员名，是文件名的一部分（`chess.json` 的 `json`）。 */
const EXT_SEG = new Set(['js', 'mjs', 'json', 'md', 'css', 'html']);

/** 引用之前 chars 个字符，跨过表格单元 / 句号 / 换行就重新开始。 */
function claimWindow(text, index, chars) {
  const w = text.slice(Math.max(0, index - chars), index);
  const cut = Math.max(w.lastIndexOf('\n'), w.lastIndexOf('|'), w.lastIndexOf('。'), w.lastIndexOf('；'));
  return cut >= 0 ? w.slice(cut + 1) : w;
}

/** 一处引用被这条判据点名的成员名（去重），没有就是「判不了，跳过」。 */
function claimedMembers(text, index) {
  const segs = new Set();
  for (const [root, chars] of Object.entries(CLAIM_ROOTS)) {
    for (const d of claimWindow(text, index, chars).matchAll(DOTTED)) {
      if (d[1].split('.')[0] !== root) continue;
      const seg = d[1].split('.').pop();
      if (seg.length >= 3 && !EXT_SEG.has(seg)) segs.add(seg);
    }
  }
  return [...segs];
}

/** 这份文档里**能判**的引用数（判据的覆盖面，用来断言抽取没有空转）。 */
function judgedClaims(text) {
  return [...text.matchAll(CITATION)].filter((m) => claimedMembers(text, m.index).length > 0).length;
}

/** 判不过的引用：句子里点名的成员一个都没出现在被引用的那些行上（附上该成员真正在哪一行，好让人一眼能改）。 */
function staleMemberClaims(text, name) {
  const bad = [];
  for (const m of text.matchAll(CITATION)) {
    const [, rel, from, to] = m;
    const members = claimedMembers(text, m.index);
    if (!members.length) continue;
    if (!existsSync(join(ROOT, rel))) continue; // 文件不存在是上面那条测试的事
    const src = lines(rel);
    if (Number(to ?? from) > src.length) continue; // 行号越界也是上面那条测试的事
    const cited = src.slice(Number(from) - 1, Number(to ?? from)).join('\n');
    if (members.some((s) => cited.includes(s))) continue;
    const docLine = text.slice(0, m.index).split('\n').length;
    const missing = members.filter((s) => !cited.includes(s));
    // 提示「这个成员真正在哪一行」：先找赋值 / 对象字面量里的键（`this.flags =`、`flags:`），再找属性访问，
    // 最后才退化成子串 —— 否则一条注释里提到过它就够骗过这个提示（实测会指到 Battle.js 开头的说明注释）。
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const firstLine = (s) => {
      const assign = new RegExp(`(^|[^\\w$.])${esc(s)}\\s*[:=]`);
      const prop = new RegExp(`\\.${esc(s)}\\b`);
      for (const re of [assign, prop]) {
        const i = src.findIndex((l) => re.test(l));
        if (i >= 0) return i + 1;
      }
      const j = src.findIndex((l) => l.includes(s));
      return j >= 0 ? j + 1 : 0;
    };
    const real = missing.map((s) => {
      const at = firstLine(s);
      return `${s}${at ? `（在 ${rel}:${at}）` : '（整个文件里都没有）'}`;
    });
    bad.push(`${name}:${docLine} 说 ${real.join(' / ')} 在这里，而它引的是 ${rel}:${from}`);
  }
  return bad;
}

/**
 * 三条判据共用的收尾断言：**一处都不许有**。
 * @param {Array<{doc: string, msg: string}>} bad
 * @param {string} what
 */
function assertNone(bad, what) {
  assert.deepEqual(bad.map((b) => b.msg), [], `${what}：\n${bad.map((b) => b.msg).join('\n')}`);
}

describe('文档里的代码引用（docs/prompts + docs/design，点进去必须有东西）', () => {
  test('每个 `文件:行号` 引用都存在、行号在范围内、那一行有内容', () => {
    assert.ok(FILES.length >= 11, `两份文档目录下的 .md 应当不止几份，实际找到 ${FILES.length} 份`);
    const bad = [];
    let total = 0;
    for (const docRel of FILES) {
      const text = readFileSync(join(ROOT, docRel), 'utf8');
      for (const m of text.matchAll(CITATION)) {
        const [, rel, from, to] = m;
        total += 1;
        const docLine = text.slice(0, m.index).split('\n').length;
        const push = (msg) => bad.push({ doc: docRel, msg: `${docRel}:${docLine} ${msg}` });
        if (!existsSync(join(ROOT, rel))) {
          push(`引用的 ${rel} 不存在`);
          continue;
        }
        const src = lines(rel);
        if (Number(to ?? from) > src.length) {
          push(`引用的 ${rel}:${to ?? from} 超出范围（该文件只有 ${src.length} 行）`);
          continue;
        }
        const cited = src[Number(from) - 1].trim();
        // 指向空行 / 只有括号的行 = 行号漂了，读者点进去看不到文档在说的东西
        if (!cited || /^[)}\]);,]+$/.test(cited)) {
          push(`引用的 ${rel}:${from} 那一行是空的（行号漂了）`);
        }
      }
    }
    assert.ok(total > 300, `引用数量看起来不对（只有 ${total} 处）—— 正则是不是失效了？`);
    assertNone(bad, '这些引用点不到东西');
  });

  test('以仓库顶层目录开头的裸引用（不带行号的那些）也必须存在', () => {
    const bad = [];
    for (const docRel of FILES) {
      const text = readFileSync(join(ROOT, docRel), 'utf8');
      const seen = new Set();
      for (const m of text.matchAll(BARE)) {
        const rel = m[0].replace(/^\.\//, '');
        if (!TOP_DIRS.some((d) => rel.startsWith(d))) continue;
        if (seen.has(rel)) continue;
        seen.add(rel);
        // 装出来的目录（判不了它存在）与**包内**路径（不是本仓库的文件）都不判 —— 见上面两份名单的注释。
        if (NOT_IN_A_FRESH_CHECKOUT.some((e) => rel === e || rel.startsWith(e) || `${rel}/` === e)) continue;
        if (PACK_INTERNAL_PATHS.includes(rel)) continue;
        if (!existsSync(join(ROOT, rel))) bad.push({ doc: docRel, msg: `${docRel}: 裸引用 ${rel} 不存在` });
      }
    }
    assertNone(bad, '这些路径不存在');
  });

  // 上面那条只查「点进去有没有东西」。还差一类：**点进去是别的东西** —— 引用指着 `Battle.js:113`，而作者说的事实
  // （`battle.flags` 是构造期输入）在 `:143`，于是文档「看起来很具体、点进去是另一行」，没有任何东西会报错。
  // 2026-10 抓到 3 处（都在 `docs/prompts/kit.md`，0.11.0 已修）；0.12.0 的 W-B 把 Battle.js 的构造期挪了十几行，
  // 同一批引用又一次失效 —— 这正是这条门禁存在的理由，所以这里把「**句子里点名的成员必须真出现在被引的那一行**」
  // 变成门禁。
  //
  // 判据刻意很窄（宁可漏，不可误报；误报会让这条门禁被关掉）：
  //   * 只判**带点的成员引用**，且根只有 `battle` / `this` / `flags` / `bb` / `ctx` 这五个引擎语境词 —— 裸名字
  //     （`inRect`、`hit`、`onEnd`、`true`、`kind === 'normal'`）不判：它们常常是在说调用点 / 概念，不是在说声明；
  //   * 只判**离引用足够近**的成员（`battle.x` / `this.x` ≤ 45 字符，`flags.x` ≤ 90），跨过 `|`（表格单元）、句号、
  //     换行就重新开始 —— 同一格里更早的那句话不算；
  //   * 只要求**任一**被点名的成员出现在被引的**整段行号区间**里（`x:12-14` 逐行拼起来查）。
  // 实测覆盖面：两份目录共 355 处引用里判 11 处（`kit.md` 181 处里判 10，`mod-layer.md` 162 处里判 1）
  // —— 这就是这条规则的代价与收益。
  test('引用点名的成员必须真的出现在被引的那一行（只判引擎语境里的成员引用）', () => {
    const bad = [];
    let judged = 0;
    for (const docRel of FILES) {
      const text = readFileSync(join(ROOT, docRel), 'utf8');
      judged += judgedClaims(text);
      for (const s of staleMemberClaims(text, docRel)) bad.push({ doc: docRel, msg: s });
    }
    assert.ok(judged >= 8, `只判到 ${judged} 处引用 —— 抽取是不是失效了？`);
    assertNone(bad, '这些引用点进去是别的东西');
  });

  // 上面那份「看起来像本仓库、其实是包内路径」的名单不许烂：每一条都得仍然出现在被扫的文档里。
  // 文档改了、那条不见了 ⇒ 这里红 ⇒ 名单跟着删（否则它会变成一份没人敢碰的豁免表）。
  test('包内路径名单里的每一条都仍然出现在被扫的文档里', () => {
    const all = FILES.map((rel) => readFileSync(join(ROOT, rel), 'utf8')).join('\n');
    const gone = PACK_INTERNAL_PATHS.filter((p) => !all.includes(p));
    assert.deepEqual(gone, [], '这些已经不在任何被扫文档里了，请从 PACK_INTERNAL_PATHS 删掉');
  });

  test('这条判据本身有牙：指错一行的合成引用会被抓出来', () => {
    // 拿真实文件当靶子：`:124` 与 `:150` 现在都指向 Battle.js，只有一处写着 flags
    // （第 8 刀在 Battle.js 上给 morphPairing 的作用域加了一行，`flags` 由 149 位移到 150；
    //  这一对合成引用是**靶子**，跟着真实行号走 —— 断言本身一字不放松。）
    const stale = '`battle.flags` 是构造期输入（`server/sim/Battle.js:124`）';
    const right = '`battle.flags` 是构造期输入（`server/sim/Battle.js:150`）';
    assert.equal(staleMemberClaims(stale, 'fixture').length, 1, '指错一行必须报出来');
    assert.deepEqual(staleMemberClaims(right, 'fixture'), [], '指对了不许报');
    // 裸名字不判：`inRect` 的引用常常是在说调用点，不是在说声明（误报会让这条门禁被关掉）
    assert.deepEqual(staleMemberClaims('`inRect`（`server/sim/battle/tiles.js:66`）', 'fixture'), []);
  });
});
