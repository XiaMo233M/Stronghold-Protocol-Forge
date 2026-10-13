// editor/ui/errHints.zh.js — 「错误码 → 一句话人话 + 一条修法」（A5，2026-10-13）。
//
// 为什么有这一层：引擎报的是**判据**（`ASSETS_NEED_LICENSE: this pack has an assets/ folder, so pack.json
// must declare a license (…)`），而作者要的是**动作**（「加一行 `"license": "CC0-1.0"`」）。同一条码在
// pack.js（加载器点名的拒绝）与 app.js（逐记录校验）两条渲染路径上各出现一次，映射表只有这一份 ——
// 两处都从这里取，改一次两边一起变。
//
// 三条纪律：
//   1. **查不到就回落显示原文，绝不静默**（`hintFor` 返回 null，调用方必须把 `[CODE] 原文` 原样打出来）。
//      这条与 `test/errHints.test.js` 的「未知码必须回落」断言是一对。
//   2. 表里**只有数据，没有逻辑**，也不 import 任何东西：它是纯 ESM 模块，仍然零依赖、无构建。
//   3. 文案本身走 `t()`，**但 t() 只在这一层收口**（`explainCode()`）：数据文件不带 t()，所以
//      `test/editorI18n.test.js` 的「源码里每条 t('中文') 都要有译文」能精确地只管住真正写给用户的
//      那几个字符串，而不是把整张数据表也拖进词典。
//
// 十条的选择依据：`_up/workshop-ui/00-界面侦察与优化方案.md` 第三节 A5 —— 小白最常撞的十条。
// `TRAIT_GRANT_*` 三条来自 `shared/morph.js` 的 `traitGrantIssues`（装载期与作者侧**同一个函数**），
// 不在 `shared/workshop.js` 里 —— 按码查而不是按文件查，所以这里照收。

import { currentLang } from './i18n.js';

/**
 * 一条英文词条的**可选**覆盖：英文界面下真正渲染的是这里，没有条目就退回中文那句。
 *
 * 为什么值得写：表里那十条中文是给中文作者写的，英文界面下**照抄过来是完整可用的英文**（数据文件本身
 * 不是语言相关的）—— 但如果一个界面文案里**混了英文标识符**（`trait.grantsBonds`、`"api"`、`assets/`），
 * 那条中文句子在英文界面下读起来就别扭。这十条正是这种情况，所以逐条给了英文。
 *
 * 这份表只被 `pick()` 读，不被 test/editorI18n.test.js 扫（它不是 `t('…')`），所以不会污染词典。
 * @type {Readonly<Record<string, { plain: string, fix: string }>>}
 */
const EN_HINTS = Object.freeze({
  EMPTY_PACK: {
    plain: 'This pack brings nothing: installing it changes nothing, so the engine refuses it.',
    fix: 'What are you trying to do? Swap art (portraits / icons / voices) \u2192 art; add data (operators / items) \u2192 content; add interface \u2192 client; post a notice \u2192 notices. Note: support alone is not content \u2014 it only says who may enter the support pool.',
  },
  PACK_ID_COLLISION: {
    plain: 'Another pack already contributed a record with this id: two packs want the same slot.',
    fix: 'The engine lets the lexicographically smaller pack id win (install order does not matter) and drops the loser entirely. Give this record another id, or rename the pack so its id sorts later.',
  },
  ASSETS_NEED_LICENSE: {
    plain: 'Your pack contains images but declares no licence.',
    fix: 'Add one line to pack.json saying whether others may pass the image on: "license": "CC-BY-4.0" (keep your credit) or "CC0-1.0" (use it freely). It is required only when the pack has an assets/ folder.',
  },
  PACK_ID_MISMATCH: {
    plain: 'The folder name and the "id" in pack.json are not the same word; the engine skips the whole pack (and reports nothing).',
    fix: 'Pick one: rename the folder to the word in "id", or change "id" to the folder name. Both sides must match exactly.',
  },
  PACK_UNKNOWN_FIELD: {
    plain: 'pack.json carries a field this engine does not know. An unknown key is never read at all, so the engine refuses the whole pack instead of ignoring it silently.',
    fix: 'Delete the line the error names. You never write the pack type \u2014 the engine derives it from what you declare. Common cases: type \u2192 delete; app \u2192 client / server; authors \u2192 author; englishName \u2192 name; target \u2192 api + game.',
  },
  BAD_API_TYPE: {
    plain: 'The value of "api" must be a string (a version range); you wrote another type.',
    fix: 'Put quotes around the value: write "api": ">=1 <2", not "api": 1.',
  },
  ART_NEEDS_ASSETS: {
    plain: 'Your pack.json declares art (its own appearance assets), but the engine finds no assets folder inside the pack directory.',
    fix: 'Create a folder next to pack.json, all lowercase: assets, and put the image inside. It lives in the pack, on the same level as pack.json, and the path is relative to assets/ (for example portrait.png).',
  },
  TRAIT_GRANT_BAD_SHAPE: {
    plain: 'The shape of trait.grantsBonds in the chess record is wrong \u2014 it must be an array of bond ids.',
    fix: 'Write it like "grantsBonds": ["yanShip"]. Entries must be non-empty strings: a single null or number voids the whole slot.',
  },
  TRAIT_GRANT_EMPTY: {
    plain: 'trait.grantsBonds is an empty array \u2014 it declares nothing and can never take effect.',
    fix: 'Either remove the slot, or write in the bond ids this trait really should grant.',
  },
  TRAIT_GRANT_UNKNOWN_BOND: {
    plain: 'A bond id named in trait.grantsBonds does not exist in this install.',
    fix: 'Bond ids follow the keys of data/bonds.json (bonds another pack adds also count, but that pack must be present). Use an id that really exists, or bring the bond this pack needs along with it.',
  },
});

/** 现在渲染的是哪一种语言的那一半。 */
const isEnglish = () => currentLang() === 'en';
/**
 * 两个**界面标签**（不是数据）：它们不放进 i18n 词典 —— 那两把键会变成「词典里有、源码里没有
 * `t('…')`」的死键（test/editorI18n.test.js 会红），而它们的两种语言写法本来就只有这一个读者。
 * 选它：这两个词是**本模块**的界面文字，就近定义比跨文件登记清楚。
 */
const LABEL_FIX = { zh: '修法', en: 'How to fix it' };
const LABEL_ENGINE = { zh: '引擎原文', en: 'Engine text' };
const label = (pair) => (isEnglish() ? pair.en : pair.zh);
/**
 * 取一条提示的某一半：**语言相关的字符串不走 `t()`**。
 *
 * 为什么不走：`t()` 的键是中文原文，用它就得把十条中文整句搬进英文词典（多 20 条长句），
 * 而 `test/editorI18n.test.js` 的扫描把「界面文案」与「界面文案」附近的东西一起收进来，
 * 边界会变得含混。这里只有**两个固定的界面标签**（修法 / 引擎原文）走词典，
 * 十条正文是**数据**（`glossary`），按语言整句选。
 * @param {{plain: string, fix: string}} hit 中文条目
 * @param {string} code
 * @param {'plain'|'fix'} half
 */
function half(hit, code, key) {
  if (isEnglish()) {
    const en = EN_HINTS[code];
    if (en && typeof en[key] === 'string' && en[key]) return en[key];
  }
  return hit[key];
}

/**
 * 十条最常撞的错误码。每一条两句话：`plain` = 发生了什么（人话），`fix` = 你该改哪个字（一步一条）。
 * @type {Readonly<Record<string, { plain: string, fix: string }>>}
 */
export const ERR_HINTS = Object.freeze({
  EMPTY_PACK: {
    plain: '这个包什么都没带，装上去不会有任何变化，所以引擎不收。',
    fix: '你想做什么？换素材（立绘 / 图标 / 语音）→ 写 art；加数据（干员 / 装备）→ 写 content；加界面 → 写 client；发公告 → 写 notices。注意：只写 support 不算内容 —— 那只是说「谁能进助战池」。',
  },
  PACK_ID_COLLISION: {
    plain: '另一个包已经放了一条同 id 的记录，两个包抢同一个位置。',
    fix: '引擎按包 id 的字典序决定谁赢（与安装顺序无关），输的那个整条丢掉。给这条记录换个 id，或者把包 id 改成字典序更大的一个。',
  },
  ASSETS_NEED_LICENSE: {
    plain: '你的包里有图片，但没写授权。',
    fix: '在 pack.json 里加一行告诉别人这张图能不能转发："license": "CC-BY-4.0"（保留你的署名即可）或 "CC0-1.0"（随便用）。只有包里存在 assets/ 文件夹时才强制。',
  },
  PACK_ID_MISMATCH: {
    plain: '文件夹名和 pack.json 里的 "id" 不是同一个词，引擎会整包跳过（而且不报错）。',
    fix: '挑一个：把文件夹改名成 "id" 里那个词，或者把 "id" 改成文件夹名。两边必须一模一样。',
  },
  PACK_UNKNOWN_FIELD: {
    plain: 'pack.json 里多了一个引擎不认识的字段。引擎不认识的键一个字节都不会读，所以它直接整包拒绝，而不是默默忽略。',
    fix: '把错误里点名的那一行删掉。包的类型不用你写 —— 引擎会看你声明了什么自己判断。高频对照：type → 删掉；app → client / server；authors → author；englishName → name；target → api + game。',
  },
  BAD_API_TYPE: {
    plain: '"api" 的值必须是一个字符串（版本区间），你写成了别的类型。',
    fix: '给值两边加引号：写 "api": ">=1 <2"，不要写 "api": 1。',
  },
  ART_NEEDS_ASSETS: {
    plain: '你的 pack.json 声明了 art（自带外观素材），但引擎在包目录下没找到 assets 这个文件夹。',
    fix: '在 pack.json 旁边新建一个文件夹，名字全小写：assets，把图片放进去。它在包内，和 pack.json 同一层，路径写成相对 assets/ 的样子（例如 portrait.png）。',
  },
  TRAIT_GRANT_BAD_SHAPE: {
    plain: 'chess 记录里 trait.grantsBonds 的形状不对 —— 它必须是「盟约 id 的数组」。',
    fix: '写成 "grantsBonds": ["yanShip"] 这样。里面只能是**非空字符串**，一个 null、一个数字都会让这一格整条作废。',
  },
  TRAIT_GRANT_EMPTY: {
    plain: 'trait.grantsBonds 是一个空数组 —— 声明了个寂寞，永远不会生效。',
    fix: '要么把这一格删掉，要么把你这条特质真的要授予的盟约 id 写进去。',
  },
  TRAIT_GRANT_UNKNOWN_BOND: {
    plain: 'trait.grantsBonds 里写的盟约 id，这个安装里没有。',
    fix: '盟约 id 要以 data/bonds.json 的键为准（别的包加进来的也算，但那个包必须在场）。改成一个真实存在的 id，或者把这个包自己需要的盟约一起带进来。',
  },
});

/**
 * 按码取白话条目。
 * @param {unknown} code 加载器 / 校验器给的错误码
 * @returns {{ plain: string, fix: string } | null} 查不到返回 **null**（调用方回落到原文，不许静默）
 */
export function hintFor(code) {
  if (typeof code !== 'string' || !code) return null;
  return Object.prototype.hasOwnProperty.call(ERR_HINTS, code) ? ERR_HINTS[code] : null;
}

/**
 * 把一条错误码翻成两句人话。
 *
 * @param {unknown} code
 * @returns {{ code: string, plain: string, fix: string, known: boolean }} `known: false` 表示**查不到**，
 *   此时 `plain` 为空串、`fix` 为空串，调用方必须自己把原文打出来（`errLine()` 就是这么做的）。
 */
export function explainCode(code) {
  const hit = hintFor(code);
  const name = typeof code === 'string' ? code : String(code ?? '');
  if (!hit) return { code: name, plain: '', fix: '', known: false };
  return { code: name, plain: half(hit, name, 'plain'), fix: half(hit, name, 'fix'), known: true };
}

/**
 * 一条渲染好的错误行：**查得到**时给 `[码] 一句话人话` 加一行修法；**查不到**时把引擎原文原样附上。
 *
 * 「查不到就回落显示原文」是这一层的核心承诺：一条没进表的码（引擎里有一百多条）绝不能变成空白，
 * 也不能变成一句「未知错误」。调用方把 `[CODE] reason` 里的 reason 作为 `detail` 传进来即可。
 *
 * @param {{ code?: unknown, detail?: unknown, field?: unknown }} issue
 * @returns {string} 单行文本（`\n` 由调用方决定怎么显示）
 */
export function errLine(issue) {
  const { code, plain, fix, known } = explainCode(issue?.code);
  const detail = issue?.detail === undefined || issue?.detail === null || issue.detail === '' ? '' : String(issue.detail);
  const field = issue?.field === undefined || issue?.field === null || issue.field === '' ? '' : String(issue.field);
  if (!known) {
    // 回落：码 + 原文，一个字都不省略
    const head = field ? `[${code}] ${field}：${detail}` : `[${code}] ${detail}`;
    return head.trim();
  }
  const head = field ? `[${code}] ${field}：${plain}` : `[${code}] ${plain}`;
  const tail = detail ? `\n    ${label(LABEL_ENGINE)}：${detail}` : '';
  return `${head}\n    ${label(LABEL_FIX)}：${fix}${tail}`;
}
