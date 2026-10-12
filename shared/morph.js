// shared/morph.js — 变形同构体（`data/items.json` 里 `canGiveBond: true` 的那件装备）的**配对规则**，一份判据三处用
// （DESIGN §28.43.1 第三格，行为开关 `morphPairing`；投稿 `19ea65909cf6`）。
//
// 官方规则（band 变形者集群「与特定装备一同装备时装备者将视为特定盟约成员」；装备天赋 character_table
// trap_1073_acarm073 列出 14 条配对）在**本引擎今天**的实现里被读成两条：
//   * **占一个装备位**：`items.length >= 2` 才算「配上了」（`server/match/bondsMeta.js` 的 `pieceBonds`、
//     `server/sim/content/support/index.js` 的 `unitBonds`、客户端 `public/js/ui/gameLogic/bonds.js` 的
//     `grantedBonds` 三处逐字同一条）；
//   * **配对上的每一件 `giveBondId` 装备都授予**其盟约。
//
// 投稿 `19ea65909cf6`（「变形同构体加强」，其 `files.json` 的 `copy` 整份覆盖 `shared/morph.js` 与那三处读取点）
// 要的是**反向**的那一套：**不占装备位**（两格满了也能装）、每名干员**只能装一件**、只取装备行里**最左边**能授予
// 盟约的那一件。本文件把那两套收成**一个闭枚举的档位**（`official` / `plus`），并让三处读取点**调的同一份纯函数**
// —— 三处各写一份循环正是这条规则历史上最容易分叉的地方（一份改了、另两份没改，客户端显示与服务端计数就打架）。
//
// 这一份是**纯**的（`shared/` 的纪律）：没有 `process`、没有状态、没有文件系统，服务端与浏览器读到同一个判决。

/** 行为开关 `morphPairing` 的档位名。 */
export const MORPH_PAIRING_OPTIONS = Object.freeze(['official', 'plus']);
export const MORPH_PAIRING_DEFAULT = 'official';

/** 这件装备是不是变形同构体本身（数据标记 `canGiveBond`）。 */
export const isMorphCarrier = (rec) => !!(rec && rec.canGiveBond);

/**
 * 这件装备**授予**盟约吗（它是「配对的那一半」）。与档位无关：两档的差别是「要几件」「授予几件」，不是
 * 「哪件算配对件」。
 * @param {any} rec 一件 items 记录
 * @returns {boolean}
 */
export const grantsBond = (rec) => !!(rec && !rec.canGiveBond && typeof rec.giveBondId === 'string' && rec.giveBondId);

/**
 * 归一化行为开关 `morphPairing` 的档位。收三种输入，因为三处读取点拿到的东西形状不同：
 *   * 归一化后的**声明数组**（`[{ switch, option, ... }]`，服务端 `Match.behaviour`）⇒ 找那一格、取它的选项；
 *   * 一个**字符串**（客户端从 `welcome.mods` 派生的有效档位）⇒ 认得的档位就用它；
 *   * 其余（`null` / 缺项 / 不认识的字符串）⇒ **缺省档 `official`**，也就是引擎今天的行为。
 * @param {Array<{ switch?: string, option?: string }>|string|null|undefined} decl
 * @returns {'official'|'plus'}
 */
export function morphPairingOf(decl) {
  if (typeof decl === 'string') return MORPH_PAIRING_OPTIONS.includes(decl) ? decl : MORPH_PAIRING_DEFAULT;
  if (!Array.isArray(decl)) return MORPH_PAIRING_DEFAULT;
  const hit = decl.find((e) => e && e.switch === 'morphPairing');
  return hit && MORPH_PAIRING_OPTIONS.includes(hit.option) ? hit.option : MORPH_PAIRING_DEFAULT;
}

/**
 * **这一格唯一的判据**：一名干员身上的装备（**按装备行顺序**）通过变形同构体授予哪些盟约。
 *
 * `official`（缺省，引擎今天的行为）：
 *   * 少于两件装备 ⇒ **什么都不授予**（它占一个装备位 —— 两件就是「它 + 配对的另一件」）；
 *   * 身上没有变形同构体 ⇒ 什么都不授予；
 *   * 有 ⇒ **每一件** `giveBondId` 装备都授予它的盟约（按装备行顺序，去重）。
 * `plus`（投稿那一套）：
 *   * **不要求件数**（它不占装备位，一件也能配对 —— 它自己）；
 *   * 身上没有变形同构体 ⇒ 什么都不授予；
 *   * 有 ⇒ **只**取装备行里**最左边**那一件能授予盟约的（`[leftmost]`），其余不授予。
 *
 * 返回的是**授予来的**盟约（调用方再与棋子自己的 `bonds` 并起来、去重）。`hasBond` 可选：服务端/战斗用它把
 * 数据里不存在的盟约 id 挡掉（与今天那三处 `.filter(Boolean)` 同一条），客户端不传（它没有权威数据）。
 *
 * @param {Iterable<any>} recs 装备记录，**按装备行顺序**（`undefined` 项由调用方先滤掉）
 * @param {{ morphed?: any, hasBond?: ((bondId: string) => boolean)|null }} [opts] `morphed` = 行为开关的档位或声明
 * @returns {string[]}
 */
export function grantedBondsByMorph(recs, { morphed = null, hasBond = null } = {}) {
  const list = Array.isArray(recs) ? recs : [...(recs || [])];
  const option = morphPairingOf(morphed);
  if (option === MORPH_PAIRING_DEFAULT && list.length < 2) return [];
  if (!list.some(isMorphCarrier)) return [];
  const ok = (id) => (typeof hasBond === 'function' ? !!hasBond(id) : true);
  const out = [];
  for (const rec of list) {
    if (!grantsBond(rec) || !ok(rec.giveBondId)) continue;
    if (!out.includes(rec.giveBondId)) out.push(rec.giveBondId);
    // `plus`：只取**最左边**那一件（`official`：全部）
    if (option === 'plus') break;
  }
  return out;
}

/**
 * 变形同构体贴在装备行里的位置（`plus` 档下它不占位，所以调用方要按这个判断「这一行有几件真的占位」）。
 * 与上面那条判据同一个来源：它只回答「哪一件是变形同构体」。
 * @param {Iterable<any>} recs @returns {number[]} 命中的下标（`official` 档下最多一件）
 */
export function morphCarrierIndexes(recs) {
  const list = Array.isArray(recs) ? recs : [...(recs || [])];
  const out = [];
  list.forEach((rec, i) => { if (isMorphCarrier(rec)) out.push(i); });
  return out;
}
