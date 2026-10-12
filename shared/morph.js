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
// 第 7 段（同一格 `morphPairing` 的**另一半**）：投稿还要求**装备位语义** —— 「不占装备位 / 每名干员只一件 /
// 第三件顶掉真正占格的那两件」。那一半落在**装备位**那套既有实现上（`server/match/player/items.js` 的 `_attach` /
// `_takeReplaced`、`server/match/player/acquire.js` 的回收、`server/match/bot.js` 的选人、`server/match/invariants.js`
// 的不变量、客户端的 `EQUIP n/2` 与替换对话框），所以这里把它收成**一个策略对象**（`morphSlotPolicy`），让那些
// 读取点写**无分支**的代码：
//   * `official`（缺省）⇒ `OFFICIAL_SLOT_POLICY`：**一个共享的冻结单例**，`slotsUsed` 逐字就是 `items.length`、
//     `isSlotless` 恒假、`slotCap` / `maxItems` 逐字就是 `equipPerChess`。缺省路径的算术与从前**逐字节相同**（同一批数字、同一次
//     比较、同一个 splice 下标），所以**不需要 `golden:update`**；
//   * `plus` ⇒ `PLUS_SLOT_POLICY`：变形同构体不占位、每名干员最多一件、顶替只挑真正占格的那一件。
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

// ---- 装备位语义（第 7 段）------------------------------------------------------------------------------------

/**
 * 装备位策略的形状（两档共用；`active` 只用来读，判据本身是那几个方法）。
 *
 * 两个「上限」是**两件事**，别混：
 *   * `slotCap(equipPerChess)` —— **真正占几格**的上限（两档都是官方的 `equipPerChess`：两格装备位是官方的）。
 *     界面上的 `EQUIP n/2` 分母读它，`_attach` 的「满了没」也读它；
 *   * `maxItems(equipPerChess)` —— 一行**最多能有几件**（`plus` 档 = 装备位数 + 1：那件不占位的也在行里）。
 *     只有不变量那条「一行最多几件」读它。
 * @typedef {object} MorphSlotPolicy
 * @property {boolean} active `plus` 档为 `true`（缺省档 `false`）
 * @property {(rec: any) => boolean} isSlotless 这件装备**不占**装备位吗
 * @property {(items: Iterable<any>, getItem?: ((arg: any) => any)|null) => number} slotsUsed 这一行**占了几格**
 * @property {(equipPerChess: number) => number} slotCap 真正占格的上限（两档都 = `equipPerChess`）
 * @property {(equipPerChess: number) => number} maxItems 这一行最多能有几件
 * @property {(items: Iterable<any>, rec: any, equipPerChess: number, getItem?: ((arg: any) => any)|null) => boolean} canHold 还能再放这一件吗
 * @property {(items: Iterable<any>, replaceUid: number|null, getItem?: ((arg: any) => any)|null) => number} replacedIndex
 *   顶替时从哪个下标取下（`-1` = 没有可顶替的）
 */

/**
 * 一行装备里的一项 → 它的 items 记录。
 *
 * **`getItem` 的契约（`MorphSlotPolicy` 的一格）**：收一个 **id 字符串**，回 items 记录 —— 与客户端既有的
 * `(id) => data.lookup('items', id)`（`public/js/data.js` 的 `getItem`、`detailPanel.js`、`placementContext` 的
 * `getItem`）逐字同形，所以客户端一个字节都不用改。服务端六个读取点也统一写成 `(id) => gd.item(id)`。
 *
 * 传进来的项可以是 `{ id }` 棋子、裸 id 字符串，或**已经是一条 items 记录**（`canHold` 的入参就是记录）。
 * 没有解析器时按「传进来的已经是记录」读（裸 id 字符串退化成 `{ id }` —— `isMorphCarrier` 读到假，官方档照旧）。
 *
 * 第 7 段第一版在这里踩过一次真 bug：`server/match/invariants.js` 写的是收**棋子**的形状、其余读取点写的是收
 * **id** 的，判据只假设了一种 ⇒ 不变量把变形同构体当成占位的普通装备。契约因此写死在这里（收 id），
 * `test/morphSlots.test.js` 的 `collectViolations` 断言是它的回归位。
 * @param {any} it @param {((id: string) => any)|null} getItem @returns {any}
 */
const resolveRec = (it, getItem) => {
  if (typeof getItem !== 'function') return typeof it === 'string' ? { id: it } : it;
  const id = typeof it === 'string' ? it : (it && it.id);
  return id == null ? null : getItem(id);
};

/**
 * 变形同构体**占几个装备位** —— 与档位无关的那半条事实：官方档下它占一个（`canGiveBond` 的装备就是普通装备），
 * `plus` 档下它占零个。写成模块层的**纯**函数（`shared/modSurface.js` 的 `behaviour` 那一格可锚的导出名）：
 * 调用方要「不传策略也算一行占位」时用它。
 * @param {Iterable<any>} items 装备记录，或棋子（给了 `getItem` 时）
 * @param {((id: string) => any)|null} [getItem]
 * @param {{ morphed?: any }} [opts] `morphed` = 这一局的档位或声明；缺省 ⇒ 官方档
 * @returns {number}
 */
export function equipSlotsUsed(items, getItem = null, { morphed = null } = {}) {
  return morphSlotPolicy(morphed).slotsUsed(items, getItem);
}

/**
 * `official`（缺省档）的装备位策略：**一个共享的冻结单例**，每一个方法都逐字是引擎今天那条算术。
 *
 * 为什么是**共享单例**而不是每次新建：调用方可以拿 `===` 断言「这一局走的是缺省档」，而 `morphSlotPolicy()` 在
 * 缺省输入下**必须**返回它（`test/morphPairing.test.js` 钉住这一点）。它不是「另一套实现」，是**同一套**：
 * `slotsUsed` 就是 `items.length`、`slotCap` / `maxItems` 就是 `equipPerChess`、`replacedIndex` 就是今天那个
 * 「`replaceUid` 找不到 ⇒ 0（最旧的那件）」。
 * @type {Readonly<MorphSlotPolicy>}
 */
export const OFFICIAL_SLOT_POLICY = Object.freeze({
  active: false,
  isSlotless: () => false,
  slotsUsed: (items) => (items ? [...items].length : 0),
  slotCap: (equipPerChess) => equipPerChess,
  maxItems: (equipPerChess) => equipPerChess,
  canHold: (items, rec, equipPerChess, getItem = null) => OFFICIAL_SLOT_POLICY.slotsUsed(items, getItem) < equipPerChess,
  replacedIndex: (items, replaceUid) => {
    const list = items ? [...items] : [];
    const i = replaceUid != null ? list.findIndex((x) => x.uid === replaceUid) : -1;
    return i >= 0 ? i : 0;
  },
});

/**
 * `plus`（投稿 `19ea65909cf6` 的槽位那一半）的装备位策略：变形同构体不占位、每名干员最多一件、顶替只挑真正
 * 占格的那一件。
 *
 * 几个方法逐条对着投稿 `server/match/player/items.js` 的三处改动（本引擎把它们收在一处，而不是让 `_attach` /
 * `_takeReplaced` / `acquire` / `bot` 各写一遍「哪些件不算数」）。
 * @type {Readonly<MorphSlotPolicy>}
 */
export const PLUS_SLOT_POLICY = Object.freeze({
  active: true,
  isSlotless: (rec) => isMorphCarrier(rec),
  slotsUsed: (items, getItem = null) => {
    let n = 0;
    for (const it of items || []) if (!isMorphCarrier(resolveRec(it, getItem))) n += 1;
    return n;
  },
  // 真正占格的上限**与官方逐字相同**（两格装备位是官方的）；多出来的那一件是**不占位**的那件。
  slotCap: (equipPerChess) => equipPerChess,
  maxItems: (equipPerChess) => equipPerChess + 1,
  /**
   * 还能再放这一件吗 —— `equip` 的守卫与不变量读的是**同一条**答案（两处不许分叉）。
   * 变形同构体：每名干员最多一件；其余：真正占格的件数还没到 `equipPerChess`。
   */
  canHold: (items, rec, equipPerChess, getItem = null) => {
    const incoming = resolveRec(rec, getItem);
    if (!isMorphCarrier(incoming)) return PLUS_SLOT_POLICY.slotsUsed(items, getItem) < equipPerChess;
    return ![...(items || [])].some((it) => isMorphCarrier(resolveRec(it, getItem)));
  },
  replacedIndex: (items, replaceUid, getItem = null) => {
    const list = items ? [...items] : [];
    const pick = replaceUid != null ? list.findIndex((x) => x.uid === replaceUid) : -1;
    if (pick >= 0) return pick;
    return list.findIndex((x) => !isMorphCarrier(resolveRec(x, getItem)));
  },
});

/**
 * **这一格唯一的槽位判据**：这一局用哪一套装备位语义。
 *
 * 收的输入与 `morphPairingOf` 逐字相同（归一化声明数组 / 档位字符串 / 其余 ⇒ 缺省档），因为两个读取点拿到的东西
 * 形状不同：服务端拿 `Match.behaviour`（声明数组），客户端拿 `roomMods` 派生出来的档位字符串。
 *
 * **缺省输入的返回值是 `OFFICIAL_SLOT_POLICY` 这个对象本身**（不是等价的一份）：`official` 路径上每一个读取点
 * 走的是与从前同一批算术，所以缺省逐字节不变、不需要 `golden:update`。
 * @param {Array<{ switch?: string, option?: string }>|string|null|undefined} decl
 * @returns {Readonly<MorphSlotPolicy>}
 */
export function morphSlotPolicy(decl) {
  return morphPairingOf(decl) === 'plus' ? PLUS_SLOT_POLICY : OFFICIAL_SLOT_POLICY;
}

/**
 * 同一份判据的**对局入口**：一局 `Match` 的装备位策略（读它的 `behaviour`，那一份是 `mergeBehaviourDecls` 合成出来的
 * 归一化声明）。服务端四处读取点（`player/items.js` / `player/acquire.js` / `bot.js` / `invariants.js`）手上都只有
 * `m` 或 `ps.m`，所以给这一个薄包装 —— **判据本体仍然只有 `morphSlotPolicy` 一份**。
 *
 * 没有 `behaviour`（测试里手搓的 Match、旧调用方）⇒ 缺省档。它只读一个属性，不缓存：一次 `Array.find` 而已，
 * 而缓存在 `PlayerState.prototype` 那种混入结构上会变成两个模块争同一个 getter 的名字（`PlayerState.js` 对重复键
 * **直接抛**），不值得。
 * @param {{ behaviour?: Array<{ switch?: string, option?: string }>|null }|null|undefined} m
 * @returns {Readonly<MorphSlotPolicy>}
 */
export function matchSlotPolicy(m) {
  return morphSlotPolicy(m && m.behaviour);
}
