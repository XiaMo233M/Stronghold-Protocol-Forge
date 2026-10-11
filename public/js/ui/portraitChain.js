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
//   0. **提供者先说话**（`workshopSkins` 开关打开、且当前**真的**注册了提供者时）：问那一个提供者一次，
//      它给出可用 URL 就用它 —— 在步骤 2 **之前**。这一条是开关关掉时**整条不存在的**路径（见下面
//      `appearanceFirst`）：关掉时这一行与今天逐字相同，那是这条链最硬的不变量。
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
// **优先级（这段是「头像与立绘分开受控」的落点，逐条可断言）**：
//
//   调用方显式点名的变体 > 提供者的选择 > 官方回落
//
// 三档各有明确边界：
//   * **调用方显式点名的变体**：`opts.variant === 'elite'`，或 `id` 以 `_1` / `_2` 结尾（`_2` = E2、
//     `_1` = 一阶，两者都点名了一个**具体版本**，不是一个「哪套外观」的问题），或 `kind: 'portrait'` 且
//     `chess.isGolden`（详情页 / 商店卡那条既有语义：精锐画 `portraitE2`）。命中这一档时**不打扰提供者**，
//     直接走链自己的分支 —— 别人明确要精锐立绘，不该被一份只有一张图的时装盖掉。
//   * **提供者的选择**：调用方没有点名版本时，提供者按 `(kind, charId, id)` 回答**这一条 kind** 的 URL
//     （它拿得到 kind，见 `appearanceFirst`）。它给 null / 抛错 / 给一个没有可用字段的对象 ⇒ 掉到第三档。
//   * **官方回落**：链原来的步骤 2–5。头像那一条**不看** `isGolden`（精锐头像由调用方自己传变体，
//     `screens/diy.js` 今天就是这么做的），立绘那一条看。
//
// 三档**都只作用于被问的那一条 kind**：`portrait` 与 `avatar` 各问各的、各答各的，互不串（这就是
// 「分开受控」的另一半；另一半在提供者那一侧：按 kind 各记一份偏好）。
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
 *   variant?: 'elite',
 *   e2?: boolean,
 * }} [opts]
 *   `lookup` 是**唯一的 hook 点**：它回答「这个 id 是我知道的一套外观」。没有它时本链与今天逐字相同
 *   （`test/ui/portraitChain.test.js` 拿今天两个实现当对照逐项比对）。
 *   `variant: 'elite'` 是调用方**点名精锐**的第三种写法（另两种是 `id` 以 `_2` 结尾、`chess.isGolden`）：
 *   命中时提供者不参与，链先给这个干员的精锐字段、没有精英字段就走官方回落。
 *   另有两条**只有宿主写、包看不见**的门控：`skins`（玩家的「工坊外观」开关；`false` = 显式关掉这一步）
 *   与模块级的 `setAppearanceFirst`（设置界面同步进来的那一份，见下面）。两条与「确实注册了提供者」
 *   一起成立时，提供者在步骤 2 **之前**先被问一次 —— 但**只在这个调用方没有点名版本时**（见下面的
 *   `appearanceFirst` 与文件头的优先级那一段）。
 * @returns {string|null} URL，或 null
 */
export function portraitEntry(m, chess, opts = {}) {
  const kind = opts.kind === 'avatar' ? 'avatar' : 'portrait';
  const f = FIELDS[kind];
  const chars = charsOf(m);
  if (!chars) return null;

  const charId = strOf(chess && chess.charId);
  const id = strOf(chess && chess.assets ? chess.assets[kind] : null);
  // 步骤 0：**提供者先说话**（只有开关打开、且提供者真的在、且调用方没有点名版本时才存在这一步）
  const first = appearanceFirst(charId, id, opts, kind, chess);
  if (first) return first;

  if (id) {
    // 步骤 2：`_1` / `_2` 后缀（旧行为的第一分支）
    if (opts.variant === 'elite') {
      // 调用方显式点名精锐（与 `_2` / `isGolden` 同一条请求的第三种写法）：先给这个干员的精锐字段。
      // 没有精锐字段就不在这里下结论 —— 让下面那条**已有的**回落决定（后缀分支 / 精确命中 / 步骤 5）。
      const eliteRec = charId ? chars[charId] : null;
      const eliteUrl = eliteRec ? strOf(eliteRec[f.elite]) : null;
      if (eliteUrl) return eliteUrl;
    }
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
 *
 * **签名**：`(kind, charId, id)`。`kind` 是 `'portrait'` / `'avatar'` —— 步骤 0 送的就是这两个值（立绘与
 * 头像各问一次、各答一次）；它也是提供者「按 kind 记偏好」的唯一信息入口。同一个函数被调用方当作
 * `opts.lookup` 传给**步骤 4** 时，链送的第一参数仍是历史值 `'chars'`（那里问的是「这个 id 认不认识」，
 * 与 kind 无关）—— 提供者只需按 `id` 回答即可，`skin-picker` 就是这么写的。
 * @type {((kind: 'portrait'|'avatar'|'chars', charId: string, id: string) => object|null)|null}
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

/**
 * 玩家的「工坊外观」开关（设置 → 工坊外观，`settings.workshopSkins`）**在本链里的那一份**。
 *
 * 为什么是模块级而不是每次调用都从 store 读：本链被九处渲染路径调用（含手牌、结算页与商店卡），
 * 一处漏传一个参数就是「同一个干员在详情页换了装、在结算页还是原版」——那是这条链存在的理由本身。
 * 所以门控只有**一份**，由 `ui/settings.js`（设置的**唯一**写入面）在启动时与每次变更时同步到这里，
 * 链自己不认识设置对象、不认识 store，更不认识「皮肤」。
 *
 * **默认 `true`**，与 `DEFAULT_SETTINGS.workshopSkins: true` 同值：默认状态就是玩家装上工坊时装后
 * 看到的那一版。但默认打开**不等于**行为会变 —— 这一条还有一个前提「确实注册了提供者」，而没有 mod
 * 注册时 `appearanceLookup` 是 `null`，这一步整段不存在（`test/ui/portraitChain.test.js` 两个方向都钉）。
 *
 * 调用方**不是**唯一写入面：`opts.skins === false` 是**这一个调用点**的否决（宿主写死、单元测试用），
 * 它压过这个模块值。所以「关掉时逐字相同」有两个可断言的方向 —— 模块门控关掉，以及一个调用点自己说
 * `skins: false`（见 `appearanceFirst` 的第一行）。
 */
let appearanceFirstOn = true;

/**
 * 同步那个开关（唯一写入面是 `ui/settings.js`）。
 * @param {unknown} on
 * @returns {boolean} 同步之后**链里生效的值**
 */
export function setAppearanceFirst(on) {
  appearanceFirstOn = on !== false;
  return appearanceFirstOn;
}

/** 链里当前的开关值（守卫与设置界面读它，不猜）。 */
export const appearanceFirstEnabled = () => appearanceFirstOn;

/**
 * 步骤 0 的**全部**条件，写成一条，好让「关掉时这一步不存在」是一句可以被读出来的话：
 *
 *   1. **开关**（`appearanceFirstOn` / `opts.skins !== false`）
 *   2. **确实注册了提供者**（`appearanceLookup` 非空）
 *   3. **有 charId 也有 id**（提供者按这两样归属一套外观）
 *   4. **调用方没有点名版本**（`explicitVariant`）—— 这一条是「头像与立绘分开受控」的另一半：
 *      点名了版本的调用方**直接走链自己的分支**，提供者不参与（优先级那一段：调用方 > 提供者 > 官方回落）。
 *
 * 条件 2 就是「今天永远是死代码」那一条的原因：没有任何东西把「玩家选的那套时装 id」放到
 * `chess.assets.portrait` 上，所以提供者回答的一直是 `chars` 里没有的 id —— 而**问**这一步本身
 * 今天也不存在。现在它存在了，但它仍然**不认识皮肤**：它只是把 id 与 kind 交给提供者问一次。
 *
 * **按 kind 分开生效**：`kind` 是这一条链的问题（立绘还是头像），提供者拿到的第一参数就是它 ——
 * 于是「立绘用这套、头像还是原版」是提供者可以回答的一件事，而不是链替它猜的。链只认**一条 kind 的
 * 一个字段**（`FIELDS[kind]`，立绘只问 `portrait` / `portraitE2`，头像只问 `avatar` / `avatarE2`）：
 * 提供者给另一条 kind 的字段**不算答案**（否则一份只有 `avatar` 图的时装会把头像也画到立绘位上）。
 * 链不读、不写任何偏好 —— 「按 kind 记」由提供者决定（`ctx.session.setPref` 的键归它）。
 *
 * 问的是**模块级那一个**提供者（`appearanceLookup`），不是 `opts.lookup` —— 后者是渲染点上那一份
 * 引用，可能比注册晚（模块级单值是「谁提供外观」的唯一答案；用 `opts.lookup` 会让一个陈旧的捕获值
 * 把新注册的提供者挡在外面，而失败形态是**静默回落原版**）。
 *
 * 提供者给 URL 就用它；给 null / 抛错 / 给一个没有可用字段的对象 ⇒ 返回 null，**继续走下面原来的链**
 * （与步骤 4 逐字相同的吞异常写法：坏 mod 不外溢）。
 *
 * @param {string|null} charId @param {string|null} id @param {any} opts
 * @param {'portrait'|'avatar'} kind @param {any} chess
 * @returns {string|null}
 */
function appearanceFirst(charId, id, opts, kind, chess) {
  if (!appearanceFirstOn || opts.skins === false) return null;
  if (!appearanceLookup || !charId || !id) return null;
  if (explicitVariant(id, opts, kind, chess)) return null;
  const f = FIELDS[kind];
  const hit = ask(appearanceLookup, kind, charId, id);
  if (!hit || typeof hit !== 'object') return null;
  return strOf(hit[f.plain]) || strOf(hit[f.elite]) || null;
}

/**
 * 调用方有没有**点名一个版本**？点名了就让它先说话（`appearanceFirst` 的第一条短路）。
 *
 * 三条判据都来自「这个调用方要的是哪一个**版本**」这个问题，而不是「哪一套外观」：
 *   * `opts.variant === 'elite'` —— 调用方的显式写法（宿主用的那个口）；
 *   * `id` 以 `_1` / `_2` 结尾 —— 旧链的第一分支就是按它分流的，它就是调用方点名版本的既有编码
 *     （`_2` = 精锐、`_1` = 一阶；`public/js/ui/assetUrls.js` 逐字同一套语义）；
 *   * `kind: 'portrait'` 且 `chess.isGolden` —— 详情页 / 商店卡那条既有语义（精锐画 `portraitE2`）。
 *     **头像不看 `isGolden`**（与步骤 5 逐字同一条：精锐头像由调用方自己传变体）。
 *
 * 这三条是「别人明确要精锐立绘」的**全部**现成信号；一个没有点名版本的调用方（今天的九处渲染路径
 * 都传原版 id）仍然让提供者先说话 —— 换装照旧生效。
 *
 * @param {string} id @param {any} opts @param {'portrait'|'avatar'} kind @param {any} chess
 * @returns {boolean}
 */
function explicitVariant(id, opts, kind, chess) {
  if (opts.variant === 'elite') return true;
  if (id.endsWith('_1') || id.endsWith('_2')) return true;
  return kind === 'portrait' && !!(chess && chess.isGolden);
}

/**
 * 问一次提供者，抛错吞掉（「坏 mod 不外溢」，与步骤 4 同一条）。
 *
 * 第一参数是 `kind`（`'portrait'` / `'avatar'`）—— 与 `extensions.js` 文档里的
 * `{ lookup(kind, charId, id) }` 同一条契约，也是「立绘与头像分开受控」的信息入口：提供者按 kind
 * 回答、按 kind 记偏好。**不认识的 kind 由提供者自己回 null**（链只送这两个值）。
 */
function ask(fn, kind, charId, id) {
  try { return fn(kind, charId, id); } catch { return null; }
}
