// test/promptBaseline.test.js — 文档里「当前基线是哪个上游版本」的声明门禁。
//
// 这几处声明都是**当前态**的：上游一移植，它就必须跟着走。而它过期的样子和引用漂移不同 —— 引用指错行还有人
// 踩空，版本号写旧了**什么都不报错**：0.14.0 把上游抬到 0.2.4 时，五处都还停在旧版（中文 `README.md:179` 那处
// 已经跟上）：`docs/prompts/README.md:7`、`docs/prompts/kit.md:22`（都写「上游 0.2.2」）、`README.md:257`
// （tag 示例 `v0.14.0-0.2.3`）、`README.md:456`（「本仓库当前的底座 … v0.2.2」）、`README.md:544`（英文半边
// 「The bundled upstream game is **0.2.3**」，即 `:179` 的英文镜像）。test/promptCitations.test.js 管不了它：
// 那条门禁只判「引用点进去有没有东西」，【不看版本号】。
//
// 四类判据，都是**机械**的（判据写宽了会把历史叙述判成罪，那比不加还糟）：
//   ① 中文行里有「本版基线」+「上游」+ 三段版本号 ⇒ 上游号必须 = `docs/history/` 里最新的 `<X.Y.Z>.md` 小节；
//      同一行若写了「本仓库 X.Y.Z」，还必须 = `package.json` 的 `version`。
//   ② 中文行里有「当前的底座」+「上游」+ 版本号 ⇒ 同上。注意与移植史表格里的「**为**新底座」不是一回事：
//      后者说的是 0.8.2 / 0.10.0 当年把底座抬到哪一版，是历史事实。
//   ③ 「发行 tag 写成」（中文的 `v<forge>-<上游>` 格式示例）或「release tag spells both halves」（英文的同位
//      说法）⇒ 示例的 `v<forge>-<上游>` 两半必须分别 = `package.json` 的 `version` 与最新历史小节。
//      CHANGELOG 里那些 `发行 tag：v0.13.0-0.2.2` 是**那一版的**发行记录（用的是「发行 tag：」，不是「写成」），
//      一句都不判。
//   ④ 英文行里有「bundled upstream game is」+ 版本号 ⇒ 必须 = 最新历史小节；同一行若写了
//      「this repo's own version is X.Y.Z」，还必须 = `package.json` 的 `version`。
//
// 判据覆盖的文件只有「声明当前基线」的那几份：`docs/prompts/*.md` 与 `README.md`。三份明确不在这里：
// * `CHANGELOG.md` 是逐版台账，通篇「上游游戏本体仍是 0.2.2」都是历史事实；
// * `docs/PS100-MIGRATION.md` 是 0.2.3 期的迁移记录，留作史料（它的「上游 0.2.3」不许被当成过期声明）；
// * `docs/NET-TUNING.md` 是 0.2.4 期并行在制品（另一位写者），一个字节都不碰；**其「上游对照基线」行在该作者
//   收工后应复核一次** —— 它的 `:6` 至今写着对照 `v0.2.3` 与 `v0.2.4` 两个 tag。那份文档定稿后再决定要不要把它
//   纳入判据（现在纳入会与在制品打架）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/prompts');
const FILES = readdirSync(DIR).filter((n) => n.endsWith('.md')).sort();
/** 判据扫这些文件：prompt 文档 + README（「当前的底座」、tag 示例与英文声明都在 README 里）。 */
const DOCS = [...FILES.map((n) => `docs/prompts/${n}`), 'README.md'];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** `docs/history/<X.Y.Z>.md` 的版本号（`v2.2-playtest3.md` 那类不是版本小节，不参与）。 */
function historyVersions() {
  return readdirSync(join(ROOT, 'docs/history'))
    .map((n) => (n.match(/^(\d+\.\d+\.\d+)\.md$/) || [])[1])
    .filter(Boolean);
}

/** 三段普通 semver 比大小（< 0 ⇒ a 更旧）。 */
function cmpSemver(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
}

/** 我们实际移植到的那一版上游 = `docs/history/` 里最新的版本小节。 */
function newestUpstream() {
  const all = historyVersions().sort(cmpSemver);
  assert.ok(all.length >= 3, `docs/history 里只找到 ${all.length} 个版本小节 —— 目录是不是读错了？`);
  return all[all.length - 1];
}

/** 本仓库版本的真源（与 `shared/constants.js APP_VERSION` 同一个数，见 test/version.test.js）。 */
const APP = JSON.parse(read('package.json')).version;
/** 一个比当前版本旧的版本号，给下面那条「判据有牙」的合成用例用：**不能写死**，否则每次抬版本它自己就变成了
 *  「和 package.json 一样」，抓不到该抓的东西（0.14.0 → 0.15.0 那次就是这样红的）。 */
const OLD = `${Number(APP.split('.')[0])}.${Number(APP.split('.')[1]) - 1}.0`;

/** 「发行 tag 的格式示例」在两种语言里的写法（CHANGELOG 用的是「发行 tag：」，不在其中）。 */
const TAG_MARKER = /发行 tag 写成|release tag spells both halves/;

/**
 * 扫一份文档里的四类「当前基线」声明。
 * 返回 `{bad, kinds}`：`bad` = 判不过的那些（空 = 全绿），`kinds` = 每类各判到几处（防抽取空转）。
 */
function baselineClaims(text, rel, newest = newestUpstream(), app = APP) {
  const bad = [];
  const kinds = { baseline: 0, base: 0, tag: 0, bundled: 0 };
  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    // ① 中文「本版基线：本仓库 X / 上游 Y」
    if (/本版基线/.test(line) && /上游/.test(line) && /\d+\.\d+\.\d+/.test(line)) {
      kinds.baseline += 1;
      const up = line.match(/上游[^\d]{0,16}(\d+\.\d+\.\d+)/);
      const repo = line.match(/本仓库[^\d]{0,16}(\d+\.\d+\.\d+)/);
      if (!up) bad.push(`${at} 「本版基线」这句没点名一个三段版本的上游基线`);
      else if (up[1] !== newest) bad.push(`${at} 说上游基线是 ${up[1]}，而 docs/history 里最新的是 ${newest}`);
      if (repo && repo[1] !== app) bad.push(`${at} 说本仓库是 ${repo[1]}，而 package.json 的 version 是 ${app}`);
    }
    // ② 中文「本仓库当前的底座 | 上游 vX.Y.Z」（「为新底座」是移植史，不匹配这个词）
    if (/当前的底座/.test(line) && /上游/.test(line)) {
      kinds.base += 1;
      const up = line.match(/上游[^\d]{0,16}(\d+\.\d+\.\d+)/);
      if (up && up[1] !== newest) bad.push(`${at} 说当前的底座是 ${up[1]}，而 docs/history 里最新的是 ${newest}`);
    }
    // ③ 发行 tag 的格式示例 `v<forge>-<上游>`（中英各一处）
    if (TAG_MARKER.test(line)) {
      kinds.tag += 1;
      const tag = line.match(/`v(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)`/);
      if (tag && tag[1] !== app) bad.push(`${at} 的 tag 示例前半是 ${tag[1]}，而 package.json 的 version 是 ${app}`);
      if (tag && tag[2] !== newest) bad.push(`${at} 的 tag 示例后半是 ${tag[2]}，而 docs/history 里最新的是 ${newest}`);
    }
    // ④ 英文「The bundled upstream game is X.Y.Z」（中文 `README.md:179` 那处的英文镜像）
    if (/bundled upstream game is/.test(line)) {
      kinds.bundled += 1;
      const up = line.match(/bundled upstream game is[^\d]{0,16}(\d+\.\d+\.\d+)/);
      const repo = line.match(/repo['’]s own version is[^\d]{0,16}(\d+\.\d+\.\d+)/);
      if (!up) bad.push(`${at} "the bundled upstream game is" 没点名一个三段版本`);
      else if (up[1] !== newest) bad.push(`${at} 说打包的上游游戏本体是 ${up[1]}，而 docs/history 里最新的是 ${newest}`);
      if (repo && repo[1] !== app) bad.push(`${at} 说本仓库是 ${repo[1]}，而 package.json 的 version 是 ${app}`);
    }
  });
  return { bad, kinds };
}

describe('文档里的「当前基线」声明（必须与仓库实际状态对上）', () => {
  test('本版基线 / 当前的底座 / 发行 tag 示例 / 英文 bundled 声明，四处都对得上最新历史小节与 package.json', () => {
    const newest = newestUpstream();
    const bad = [];
    const kinds = { baseline: 0, base: 0, tag: 0, bundled: 0 };
    for (const rel of DOCS) {
      const r = baselineClaims(read(rel), rel, newest);
      bad.push(...r.bad);
      for (const k of Object.keys(kinds)) kinds[k] += r.kinds[k];
    }
    // 下面这四条**只防「抽取空转」**：判据坏了 ⇒ 一行都匹配不到 ⇒ 上面那条 deepEqual 会永远绿（假绿门禁）。
    // 它**不是**在要求「文档必须有这些声明」—— 数字就是今天真实存在的行数；哪天文档被重构，正解是来这里把下限与
    // 判据的匹配式一起更新，**不是**把文档改回去。所以失败消息必须把这两条可能说全，别让人误读成「删文档 = 违规」。
    assert.ok(kinds.baseline >= 2, `判据 ①「本版基线」只匹配到 ${kinds.baseline} 行（今天 2 行，在 docs/prompts 下 ${FILES.length} 份文档里的 2 份）—— 要么文档被重构了（请更新判据 ① 的匹配式与这里的下限），要么抽取坏了（这才是这条断言要防的：匹配不到就永远绿）`);
    assert.ok(kinds.base >= 1, `判据 ②「当前的底座」一行都没匹配到 —— 要么 README 那行被重构了（请更新判据 ②），要么抽取坏了`);
    assert.ok(kinds.tag >= 2, `判据 ③ 发行 tag 的格式示例只匹配到 ${kinds.tag} 行（今天 2 行：中文「发行 tag 写成」与英文「release tag spells both halves」各一）—— 要么它们被重构了（请更新判据 ③），要么抽取坏了`);
    assert.ok(kinds.bundled >= 1, `判据 ④ 英文「bundled upstream game is」一行都没匹配到 —— 要么 README 那处被重构了（请更新判据 ④），要么抽取坏了`);
    assert.deepEqual(bad, [], '这些「当前基线」声明与仓库现状不一致：\n' + bad.join('\n'));
  });

  test('这条判据本身有牙：四类合成过期声明都会被抓出来', () => {
    const newest = newestUpstream();
    assert.notEqual(newest, '0.2.2', '前置：0.2.2 的历史小节还在，但基线已经不是它了');
    // ① 「本版基线」写旧一版（0.14.0 那次抓到的正是这一种）：本仓库那一半与上游那一半都是旧的 ⇒ 两条都要报
    const staleBaseline = `> **本版基线**：本仓库 **${OLD}** / 打包的上游游戏本体 **0.2.2**。`;
    const caught = baselineClaims(staleBaseline, 'fixture', newest).bad;
    assert.equal(caught.length, 2, `写旧一版必须两条都报出来（本仓库那一半 + 上游那一半），实际：${JSON.stringify(caught)}`);
    assert.ok(caught.some((b) => /0\.2\.2/.test(b)), `上游那一半要报：${JSON.stringify(caught)}`);
    assert.ok(caught.some((b) => /package\.json/.test(b)), `本仓库那一半要报：${JSON.stringify(caught)}`);
    // 本仓库号对不上 package.json 也要报
    const repoBad = baselineClaims(`> **本版基线**：本仓库 **0.13.0** / 上游游戏本体 **${newest}**。`, 'fixture', newest).bad;
    assert.equal(repoBad.length, 1);
    assert.match(repoBad[0], /package\.json/);
    // 凭空多出来的一版（docs/history 里没有那个小节）也要报：本仓库那一半写对，只让上游那一半是假的
    assert.equal(baselineClaims(`> **本版基线**：本仓库 **${APP}** / 上游游戏本体 **0.2.9**。`, 'fixture', newest).bad.length, 1);
    // ② 「当前的底座」写旧一版
    const staleBase = '| 本仓库当前的底座 | 上游 **v0.2.2** 的源码树（tag `v0.2.2` = commit `62eb113`）。 |';
    assert.equal(baselineClaims(staleBase, 'fixture', newest).bad.length, 1, '底座写旧一版必须报出来');
    // ③ tag 示例漂了（前半对、后半旧；中英两种写法都要抓）
    const staleTag = `发行 tag 写成 **\`v<forge>-<上游>\`**：\`v${OLD}-0.2.3\` = 本仓库 **${OLD}** + 上游 **0.2.3**。`;
    const tagBad = baselineClaims(staleTag, 'fixture', newest).bad;
    assert.equal(tagBad.length, 2, `中文 tag 示例写旧一版两条都要报（前半 + 后半），实际：${JSON.stringify(tagBad)}`);
    assert.ok(tagBad.some((b) => /0\.2\.3/.test(b)), `后半要报：${JSON.stringify(tagBad)}`);
    assert.ok(tagBad.some((b) => /package\.json/.test(b)), `前半要报：${JSON.stringify(tagBad)}`);
    const staleTagEn = `- **The bundled game:** The bundled upstream game is **${OLD}** (this repo's own version is **${OLD}**; the release tag spells both halves, \`v${OLD}-0.2.3\`).`;
    const tagBadEn = baselineClaims(staleTagEn, 'fixture', newest).bad;
    assert.ok(tagBadEn.some((b) => /tag 示例后半是 0\.2\.3/.test(b)), `英文 tag 示例写旧一版必须报出来，实际：${JSON.stringify(tagBadEn)}`);
    assert.equal(baselineClaims(`发行 tag 写成 **\`v<forge>-<上游>\`**：\`v0.13.1-${newest}\`。`, 'fixture', newest).bad.length, 1, 'tag 前半漂了也要报');
    // ④ 英文 bundled 声明写旧一版（README:544 那次抓到的正是这一种）：上游那一半、tag 两半、本仓库那一半都是旧的 ⇒ 四条
    const staleEn = `- **The bundled game:** … The bundled upstream game is **0.2.3** (this repo's own version is **${OLD}**; the release tag spells both halves, \`v${OLD}-0.2.3\`).`;
    const enBad = baselineClaims(staleEn, 'fixture', newest).bad;
    assert.equal(enBad.length, 4, `英文 bundled 声明与它的 tag 两半、本仓库那一半都要报出来，实际：${JSON.stringify(enBad)}`);
    assert.ok(enBad.some((b) => /打包的上游游戏本体是 0\.2\.3/.test(b)), `上游那一半要报：${JSON.stringify(enBad)}`);
    assert.ok(enBad.some((b) => /tag 示例后半是 0\.2\.3/.test(b)), `tag 后半要报：${JSON.stringify(enBad)}`);
    assert.ok(enBad.some((b) => /package\.json/.test(b)), `本仓库那一半要报：${JSON.stringify(enBad)}`);
    // 四类都对（当前真值）不许报
    assert.deepEqual(baselineClaims(`> **本版基线**：本仓库 **${APP}** / 上游游戏本体 **${newest}**。`, 'fixture', newest).bad, []);
    assert.deepEqual(baselineClaims(`| 本仓库当前的底座 | 上游 **v${newest}** 的源码树。 |`, 'fixture', newest).bad, []);
    assert.deepEqual(baselineClaims(`发行 tag 写成 **\`v<forge>-<上游>\`**：\`v${APP}-${newest}\`。`, 'fixture', newest).bad, []);
    assert.deepEqual(baselineClaims(`The bundled upstream game is **${newest}** (this repo's own version is **${APP}**).`, 'fixture', newest).bad, []);
  });

  // 反例：这些写法**一句都不许判**。判宽了会误伤历史叙述，而误报会让这条门禁被关掉 —— 所以把它们写死在这里，
  // 下次有人把判据改宽（例如把「上游 x.y.z」整个当罪、把 CHANGELOG 拉进扫描范围、或让英文判据吃掉历史条目）
  // 会立刻红。
  test('判据不许误伤历史叙述（反例：上游换版的下场不是罪）', () => {
    const newest = newestUpstream();
    const cases = [
      // ① 历史小节 / CHANGELOG：那几版各自写了什么、当年发的是哪个 tag
      '- **装备栏满时再装「一次性」道具会先替换**（上游 0.2.1 起，与官方一致）：对 `consume_on_equip*` 的道具，…',
      '上游游戏本体仍是 **0.2.2**，发行 tag：`v0.13.0-0.2.2`。',
      '这一版把**上游游戏本体从 0.2.3 抬到 0.2.4**（本仓库自己的版本号仍是 `0.14.0`，发行 tag 按 `v<本仓库>-<上游>` 读作 `v0.14.0-0.2.4`）。',
      '**0.2.4 再抬一级**：按官方补齐**共享卡池与全队共享的装备库存**…',
      '// 上游 0.2.3 的四档文字大小需要 TEXT_SIZES。',
      '**因为上游 0.2.3 把克莱门莎收成了官方干员**，官方 id 正是 `char_4231_clemnt`',
      // ② 移植史表格：「为新底座」不是「当前的底座」，说的是当年抬到哪一版
      '| 5 | 0.10.0 的移植以**上游 v0.2.2** 为新底座 | `data/` 由生成器重建，产物与上游 v0.2.2 逐字节一致 |',
      '| 4 | 0.8.2 的移植以**上游 v0.2.1** 为新底座 | 逐文件用 sha256 判定（不看时间戳） |',
      '| 1 | 本仓库的**根提交**（`11aa45c6`）与上游 **v0.1.3** 的 tag 逐字节比对 | … |',
      '| **C 上游原文** | 与上游 v0.2.2 逐字节相同 | 可核实 |',
      '| 本仓库当时的底座 | 上游 **v0.2.2** 的源码树。 |',
      // ③ 提了这些词但没带版本号 / 带的是别的写法
      '「本版基线」一换，这几份 prompt 就得跟着改。',
      '> 为什么只有两个独立的 prompt 文件：干员的黑板书有 **60 多个键**…',
      // ④ 英文半边：历史条目、下载说明里的 `v<version>` 占位、`0.2.x` 区间、以及「spells both halves」以外的 tag 说法
      "0.2.2 makes an operator's potential and cultivation a per-operator, per-player runtime setting (full potential by default).",
      '**0.2.3** adds the six-star operator 克莱门莎 (three skills, two talents) …',
      'from 0.2.1 on, `…-update.zip` holds only the files changed since the earlier 0.2.x releases',
      '- **Run:** download the full bundle `Stronghold-Protocol-v<version>.zip` (~505 MB, all the art inside).',
      'Released as `v0.13.1-0.2.2`, the previous bundled game.',
    ];
    for (const line of cases) {
      const r = baselineClaims(line, 'fixture', newest);
      assert.deepEqual(r.bad, [], `历史叙述不许判罪：${line}`);
      assert.equal(r.kinds.baseline + r.kinds.base + r.kinds.tag + r.kinds.bundled, 0, `这句不该被当成声明：${line}`);
    }
  });
});
