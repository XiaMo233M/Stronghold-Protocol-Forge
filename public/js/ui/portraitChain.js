// public/js/ui/portraitChain.js —— 立绘 / 头像的**唯一解析链**。
//
// WHY THIS EXISTS
//
// 今天同一个干员有**两条**解析路径，对同一个 id 会给出不同答案：
//   * `public/js/ui/assetUrls.js chessPortraitUrl`（详情页 / 手牌 / 商店卡）只认 `_1` / `_2` 后缀，
//     别的值**静默忽略**，然后回落 `chars[chess.charId]`；
//   * `public/js/assets.js portraitUrl`（按 charId 的通用口）**先精确查 `chars[id]`**，查不到才退回 baseCharId。
//
// 没有「第三套外观」时这个差异不显形；一旦一个 id 既不是 `_1`/`_2` 后缀、又不在 `chars` 里（一套外部外观就
// 长这样），差异就变成「卡面是那套外观、详情页是原版」—— 一个**没人会报**的错（两个画面各自都对得上自己的代码）。
//
// 所以这里是**一条链**，而且旧行为是这条链的**分支**，不是例外：
//
//   1. `id = chess.assets.portrait`（数据形状**不变**）
//   2. `id` 以 `_2` 结尾 ⇒ `chars[id-2].portraitE2 || .portrait`；以 `_1` 结尾 ⇒ `chars[id-2].portrait`
//      （与 `chessPortraitUrl` 逐字相同）
//   3. 否则 `chars[id]` 精确命中 ⇒ 用它（这是 `portraitUrl` 的行为，被并进来）
//   4. 否则 `opts.lookup?.('chars', chess.charId, id)` —— **唯一的 hook 点**
//   5. 否则回落 `chars[chess.charId]`（`isGolden` 优先 `portraitE2`）
//
// `avatar` 分支走同一条链的同一批步骤（只是字段换成 `avatar` / `avatarE2`），**共用同一个 hook** —— 否则
// 头像与立绘会第二次分叉。
//
// 失败形态：忘了传 hook ⇒ 回落原版外观（可见、可解释），**永远落回 `chars[chess.charId]`**，不会串到别的干员。

/** `chars` 表，或 null。 */
const charsOf = (m) => {
  const c = m && typeof m === 'object' ? m.chars : null;
  return c && typeof c === 'object' ? c : null;
};
const strOf = (v) => (typeof v === 'string' && v ? v : null);

/**
 * 一套外观的两条字段路径（立绘与头像各一条）。写成一张表，因为 `avatar` 分支的字段名不同。
 * @param {'portrait'|'avatar'} kind
 */
const FIELDS = {
  portrait: { plain: 'portrait', elite: 'portraitE2' },
  avatar: { plain: 'avatar', elite: 'avatarE2' },
};

/**
 * 解析一个干员的立绘 / 头像。
 *
 * @param {any} m 资源清单（`data/assets.json`）
 * @param {{ charId?: string|null, assets?: { portrait?: string|null, avatar?: string|null }, isGolden?: boolean }|null} chess
 * @param {{
 *   kind?: 'portrait'|'avatar',
 *   lookup?: (kind: 'chars', charId: string, id: string) => object|null,
 *   e2?: boolean,
 * }} [opts]
 *   `lookup` 是**唯一的 hook 点**：它回答「这个 id 是我知道的一套外观」。没有它时本链与今天逐字相同
 *   （`test/ui/portraitChain.test.js` 拿今天两个实现当对照逐项比对）。
 * @returns {string|null} URL，或 null
 */
export function portraitEntry(m, chess, opts = {}) {
  const kind = opts.kind === 'avatar' ? 'avatar' : 'portrait';
  const f = FIELDS[kind];
  const chars = charsOf(m);
  if (!chars) return null;

  const charId = strOf(chess && chess.charId);
  const id = strOf(chess && chess.assets ? chess.assets[kind] : null);

  if (id) {
    // 步骤 2：`_1` / `_2` 后缀（旧行为的第一分支）
    if (id.endsWith('_2')) {
      const base = chars[id.slice(0, -2)];
      if (base) return strOf(base[f.elite]) || strOf(base[f.plain]);
    }
    if (id.endsWith('_1')) {
      const base = chars[id.slice(0, -2)];
      if (base) return strOf(base[f.plain]);
    }
    // 步骤 3：精确命中（`portraitUrl` 的行为并进来）
    const exact = chars[id];
    if (exact) return strOf(exact[f.plain]);
    // 步骤 4：唯一的 hook 点 —— 有外观提供者时它回答这一套；没有时跳过（今天就是没有）
    if (typeof opts.lookup === 'function' && charId) {
      let hit = null;
      try { hit = opts.lookup('chars', charId, id); } catch { /* 坏 mod 不外溢 */ }
      const url = hit ? strOf(hit[f.plain]) : null;
      if (url) return url;
    }
  }

  // 步骤 5：回落这个干员自己的记录。
  //
  // **立绘与头像在这一点上不同，而且必须保持不同**：
  //   * 立绘：`isGolden` ⇒ 优先 `portraitE2`（`chessPortraitUrl` 今天的语义 —— 详情页画的是精锐那一张）；
  //   * 头像：**不看 `isGolden`**。调用方自己传精锐变体（`screens/diy.js` 的
  //     `elite ? unit.assets.avatarGolden : unit.assets.avatar`），所以这里再叠一次 `isGolden` 会把
  //     「调用方明确要普通头像」的请求偷偷改成精锐头像 —— 那是**改行为**，不是统一链。
  const byChar = charId ? chars[charId] : null;
  if (!byChar) return null;
  if (kind === 'portrait' && chess && chess.isGolden) {
    const elite = strOf(byChar[f.elite]);
    if (elite) return elite;
  }
  return strOf(byChar[f.plain]) || null;
}

/** 立绘（`kind: 'portrait'` 的简写）。 */
export const portraitUrlOf = (m, chess, opts) => portraitEntry(m, chess, { ...opts, kind: 'portrait' });

/** 头像（`kind: 'avatar'` 的简写）。 */
export const avatarUrlOf = (m, chess, opts) => portraitEntry(m, chess, { ...opts, kind: 'avatar' });

/**
 * **当前生效的外观解析器**（外观提供者的注册面，见 `public/js/ui/extensions.js registerAppearanceProvider`）。
 *
 * 一个进程里最多一个提供者（后注册者被拒），所以这里是一个模块级单值而不是一张表 —— 「谁提供外观」因此没有歧义。
 * 没有 mod 注册时它是 `null`，于是 `opts.lookup` 缺席 ⇒ 链就是今天那条（这条不变量由 test 钉住）。
 * @type {((kind: 'chars', charId: string, id: string) => object|null)|null}
 */
let appearanceLookup = null;

/** 注册外观提供者（**只允许一个**）。返回是否注册成功。 */
export function setAppearanceLookup(fn) {
  if (typeof fn !== 'function') return false;
  if (appearanceLookup) return false;      // 已经有提供者：后注册者被拒（调用方负责点名报告）
  appearanceLookup = fn;
  return true;
}

/** 当前的外观 hook（没有提供者时是 `undefined`，正是「与今天逐字相同」那条路径）。 */
export const currentAppearanceLookup = () => appearanceLookup || undefined;

/** 清掉提供者（卸载 / 测试用）。 */
export function clearAppearanceLookup() { appearanceLookup = null; }
