// shared/bondAuthoring.js — 盟约（羁绊）的创作层：spec → 记录、记录 → spec、以及这个记录能被引擎接受多少。
//
// 与 shared/chessAuthoring.js 同一条思路：判断留在纯函数里（编辑器、CLI、AI 用的是同一份规则），界面只负责画。
//
// 一个盟约记录在引擎里有三层含义，缺一层不会报错，只会安静地少一点东西 —— 这三层就是本模块的核心：
//
//   1. **计数与激活**（`countMode` / `thresholds` / `countsHand` / `countsGoldenOnly` / `activeCount`）：
//      谁算成员、几个才算激活。改一个阈值立刻改变商店里的干员能不能凑出这个盟约。
//   2. **数据面**（`weight` / `isCore` / `desc` / `iconId` / `members`）：本局随机禁用会不会抽到它、界面怎么显示、
//      盟约弹窗里列出哪些成员。
//   3. **战斗加成**：官方 23 个盟约的效果在 `server/sim/content/bonds/*` 里**按 id 写死**，所以
//      ——**覆盖官方盟约**：它的处理函数会读 `data/bonds.json` 的数值，改 `bb` 立刻生效；
//      ——**新增盟约**：没有处理函数，只有把记录上的 `genericBuffs` 打开（`server/sim/content/bonds/dataDriven.js`），
//        才会按 `bb` 里的 `base_atk` / `atk_per_stack`（防御 / 生命同理）给成员加百分比。
//      这一层最容易「看起来做了但没生效」，所以界面对它说话最多。

/** 计数模式（data/bonds.json 用到的三种）。 */
export const BOND_COUNT_MODES = Object.freeze(['BOARD', 'BOARD_AND_DECK', 'BOARD_ALL_CHESS']);
/** 阈值模板（决定「往上算」还是「往下算」，以及是否只数精锐）。 */
export const BOND_THRESHOLD_TEMPLATES = Object.freeze(['count_threshold_upward', 'count_threshold_downward', 'count_threshold_upward_golden']);
/** 生效范围：BATTLE = 只在战斗里，ALL = 全程（含休整期），MANI = 调和那类特殊处理。 */
export const BOND_ACTIVE_TYPES = Object.freeze(['BATTLE', 'ALL', 'MANI']);
/** 盟约类型（数据里的写法；界面按 SEASON 显示为「赛季」）。 */
export const BOND_TYPES = Object.freeze(['SEASON', 'REGULAR']);
/**
 * 通用加成（`genericBuffs`）会读的黑板键：`base_*` 是基线，`*_per_stack` 是每层增量，量纲是比例（0.1 = +10%）。
 * 只写其中一边也合法（另一边按 0 算）。
 */
export const GENERIC_BB_KEYS = Object.freeze([
  'base_atk', 'atk_per_stack', 'base_def', 'def_per_stack', 'base_max_hp', 'max_hp_per_stack',
]);
/** 官方盟约在黑板上用到的、本模块认识但通用加成**不读**的键（写了只有官方处理器读；新盟约写了没用）。 */
export const OFFICIAL_ONLY_BB_KEYS = Object.freeze([
  'power_bond_char_cnt', 'ex_bond_char_cnt', 'base_prob', 'prob_per_stack', 'power_def_penetrate',
  'power_magic_resist_penetrate', 'respawn_time', 'sp', 'atk', 'def', 'max_hp', 'power_atk',
]);

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const isIntIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const BOND_ID_RE = /^[A-Za-z][A-Za-z0-9_\-.:]{0,63}$/;

/** 盟约 id 的一贯写法：`yanShip` 这种小驼峰 + Ship 后缀（不做强制，只用来提示）。 */
export const looksLikeBondId = (id) => typeof id === 'string' && BOND_ID_RE.test(id);

/**
 * 把一份 spec 变成一条盟约记录（`data/bonds.json` 的形状）。
 *
 * `ctx` 提供这份 spec 自己算不出来的东西：
 *   * `memberIds`  —— 携带这个盟约的干员 id（由编辑器/CLI 从**合并后的**干员表推导）；
 *   * `iconIds`    —— 本机已有的盟约图标 id（`data/assets.json` 的 `bonds` 键），用来判断图标能不能显示；
 *   * `effectIds`  —— 已有的效果 id（`data/effects.json`），用来判断 `effectId` 是否指着一条真记录。
 *
 * @param {object} spec
 * @param {{ memberIds?: string[], iconIds?: string[]|Set<string>, effectIds?: string[]|Set<string> }} [ctx]
 * @returns {{ ok: true, bond: object, warnings: string[] } | { ok: false, errors: Array<{ field: string, code: string, message: string, hint?: string }> }}
 */
export function deriveBondRecord(spec, ctx = {}) {
  const errors = [];
  const warnings = [];
  const req = (cond, field, code, message, hint) => { if (!cond) errors.push({ field, code, message, ...(hint ? { hint } : {}) }); };
  if (!isPlainObj(spec)) return { ok: false, errors: [{ field: '', code: 'NOT_AN_OBJECT', message: 'spec must be a JSON object' }] };

  const id = typeof spec.id === 'string' ? spec.id.trim() : '';
  req(looksLikeBondId(id), 'id', 'BAD_ID', 'id must start with a letter and use only letters, digits, _ - . :', 'e.g. "myShip"');
  req(typeof spec.name === 'string' && spec.name.trim(), 'name', 'MISSING', 'name is required');
  req(BOND_COUNT_MODES.includes(String(spec.countMode || 'BOARD')), 'countMode', 'BAD_ENUM', `countMode must be one of ${BOND_COUNT_MODES.join(', ')}`);
  req(BOND_THRESHOLD_TEMPLATES.includes(String(spec.thresholdTemplate || 'count_threshold_upward')), 'thresholdTemplate', 'BAD_ENUM', `thresholdTemplate must be one of ${BOND_THRESHOLD_TEMPLATES.join(', ')}`);
  if (spec.activeType !== undefined) req(BOND_ACTIVE_TYPES.includes(String(spec.activeType)), 'activeType', 'BAD_ENUM', `activeType must be one of ${BOND_ACTIVE_TYPES.join(', ')}`);
  if (spec.bondType !== undefined) req(BOND_TYPES.includes(String(spec.bondType)), 'bondType', 'BAD_ENUM', `bondType must be one of ${BOND_TYPES.join(', ')}`);

  const thresholds = Array.isArray(spec.thresholds) ? spec.thresholds.filter((n) => Number.isInteger(n) && n > 0) : [];
  req(thresholds.length >= 1, 'thresholds', 'MISSING', 'thresholds needs at least one positive integer', 'e.g. [2, 4, 6]');
  for (let i = 1; i < thresholds.length; i++) {
    req(thresholds[i] > thresholds[i - 1], 'thresholds', 'NOT_ASCENDING', 'thresholds must be strictly ascending', `got ${thresholds.join(', ')}`);
  }
  req(spec.weight === undefined || (isFin(spec.weight) && spec.weight >= 0), 'weight', 'BAD_NUMBER', 'weight must be a number >= 0');
  if (spec.thresholds !== undefined && thresholds.length !== spec.thresholds.length) {
    warnings.push('thresholds 里的非正整数已被丢掉：只接受 1 以上的整数');
  }

  const bb = isPlainObj(spec.bb) ? { ...spec.bb } : {};
  for (const [k, v] of Object.entries(bb)) {
    if (!isFin(v)) errors.push({ field: `bb.${k}`, code: 'BAD_NUMBER', message: `bb["${k}"] must be a number` });
  }
  const generic = spec.genericBuffs === true;
  const knownGeneric = GENERIC_BB_KEYS.filter((k) => isFin(bb[k]));
  if (knownGeneric.length === 0 && generic) {
    warnings.push(`打开了通用加成，但 ${GENERIC_BB_KEYS.join(' / ')} 一个都没写 —— 战斗里不会有任何加成`);
  }
  for (const k of Object.keys(bb)) {
    if (GENERIC_BB_KEYS.includes(k)) continue;
    if (OFFICIAL_ONLY_BB_KEYS.includes(k)) {
      warnings.push(`bb["${k}"] 只有官方盟约的处理器读它：覆盖官方盟约时它照样生效，**新盟约写了没用**`);
    } else {
      warnings.push(`bb["${k}"] 不是本模块认识的键：覆盖官方盟约时可能仍被官方处理器读到，新盟约里它什么也不做`);
    }
  }
  const iconIds = ctx.iconIds instanceof Set ? ctx.iconIds : new Set(Array.isArray(ctx.iconIds) ? ctx.iconIds : []);
  const iconId = typeof spec.iconId === 'string' ? spec.iconId.trim() : '';
  // 图标是**按盟约 id** 从 `data/assets.json` 的 `bonds` 里取的（`bondIconUrl(m, bondId)`），`iconId` 只是记录上的名字。
  // 一个包无法给 assets.json 加条目，所以新增的盟约一定没有图标（界面退回一个圆点）—— 这条要说出来，而不是让作者去猜。
  if (iconIds.size && !iconIds.has(id)) {
    warnings.push(`盟约 id "${id}" 在本机的盟约图标清单里没有条目（data/assets.json 的 bonds）：盟约条与详情面板会显示一个圆点。覆盖官方盟约时沿用官方图标。`);
  }
  const effectIds = ctx.effectIds instanceof Set ? ctx.effectIds : new Set(Array.isArray(ctx.effectIds) ? ctx.effectIds : []);
  const effectId = typeof spec.effectId === 'string' ? spec.effectId.trim() : '';
  if (effectId && effectIds.size && !effectIds.has(effectId)) {
    warnings.push(`效果 "${effectId}" 不在 data/effects.json 里：效果说明那段文字仍然会显示，但没有对应的效果记录`);
  }
  if (typeof spec.desc !== 'string' || !spec.desc.trim()) {
    warnings.push('desc 是空的：盟约条与详情面板会显示一个没有说明的盟约');
  }

  if (errors.length) return { ok: false, errors };

  const memberIds = [...new Set((Array.isArray(ctx.memberIds) ? ctx.memberIds : []).filter((m) => typeof m === 'string' && m))].sort();
  const bbStr = isPlainObj(spec.bbStr) ? { ...spec.bbStr } : {};
  const bond = {
    bondId: id,
    name: spec.name.trim(),
    identifier: isFin(spec.identifier) ? Math.round(spec.identifier) : (isFin(spec.bondOrder) ? Math.round(spec.bondOrder) : 50),
    isCore: spec.isCore === true,
    bondType: BOND_TYPES.includes(String(spec.bondType)) ? String(spec.bondType) : 'REGULAR',
    bondOrder: isFin(spec.bondOrder) ? Math.round(spec.bondOrder) : (isFin(spec.identifier) ? Math.round(spec.identifier) : 50),
    weight: isFin(spec.weight) ? Math.max(0, Math.round(spec.weight)) : 10,
    iconId: iconId || `icon_${id}`,
    activeCount: thresholds[0],
    thresholds: [...thresholds],
    maxCount: Number.isInteger(spec.maxCount) && spec.maxCount > 0 ? spec.maxCount : null,
    thresholdTemplate: String(spec.thresholdTemplate || 'count_threshold_upward'),
    countMode: String(spec.countMode || 'BOARD'),
    countsHand: spec.countsHand === true,
    countsGoldenOnly: spec.countsGoldenOnly === true,
    activeType: BOND_ACTIVE_TYPES.includes(String(spec.activeType)) ? String(spec.activeType) : 'BATTLE',
    isActiveInDeck: spec.isActiveInDeck === true,
    noStack: spec.noStack === true,
    maxInactiveBondCount: Number.isInteger(spec.maxInactiveBondCount) ? spec.maxInactiveBondCount : -1,
    layerMilestones: Array.isArray(spec.layerMilestones) ? [...spec.layerMilestones] : [],
    desc: typeof spec.desc === 'string' ? spec.desc : '',
    descRaw: typeof spec.desc === 'string' ? spec.desc : '',
    effectId: effectId || null,
    effectName: typeof spec.effectName === 'string' && spec.effectName ? spec.effectName : spec.name.trim(),
    effectDesc: typeof spec.effectDesc === 'string' ? spec.effectDesc : (typeof spec.desc === 'string' ? spec.desc : ''),
    effectDescRaw: typeof spec.effectDesc === 'string' ? spec.effectDesc : (typeof spec.desc === 'string' ? spec.desc : ''),
    effectDescParams: Array.isArray(spec.effectDescParams) ? [...spec.effectDescParams] : [],
    bb: { ...bb },
    bbStr,
    // 官方每条盟约都是这个形状：一个 env_gbuff_new buff，数值与顶层 bb 相同。官方处理器读的是它。
    buffs: Object.keys(bb).length ? [{ key: 'env_gbuff_new', bb: { ...bb }, bbStr: { ...bbStr } }] : [],
    baseParams: Array.isArray(spec.baseParams) ? [...spec.baseParams] : [],
    perStackParams: Array.isArray(spec.perStackParams) ? [...spec.perStackParams] : [],
    members: memberIds,
    visibleMembers: memberIds,
  };
  if (generic) bond.genericBuffs = true;
  return { ok: true, bond, warnings };
}

/**
 * `deriveBondRecord` 的反方向：把一条已发布的盟约记录变成一份可继续编辑的 spec（「以官方盟约当模板」）。
 * 只搬 spec 拥有的字段；`id` 一律留空（模板不能顺手复制 id —— 那会直接撞官方 id，或被当成覆盖官方）。
 * @param {object} rec
 * @returns {object|null}
 */
export function specFromBondRecord(rec) {
  if (!isPlainObj(rec)) return null;
  const bb = isPlainObj(rec.bb) ? { ...rec.bb } : {};
  const spec = {
    id: '',
    name: typeof rec.name === 'string' ? rec.name : '',
    isCore: rec.isCore === true,
    bondType: typeof rec.bondType === 'string' ? rec.bondType : 'REGULAR',
    bondOrder: isFin(rec.bondOrder) ? rec.bondOrder : (isFin(rec.identifier) ? rec.identifier : 50),
    identifier: isFin(rec.identifier) ? rec.identifier : (isFin(rec.bondOrder) ? rec.bondOrder : 50),
    weight: isFin(rec.weight) ? rec.weight : 10,
    iconId: typeof rec.iconId === 'string' ? rec.iconId : '',
    thresholds: Array.isArray(rec.thresholds) && rec.thresholds.length ? [...rec.thresholds] : [rec.activeCount || 2],
    maxCount: Number.isInteger(rec.maxCount) ? rec.maxCount : null,
    thresholdTemplate: typeof rec.thresholdTemplate === 'string' ? rec.thresholdTemplate : 'count_threshold_upward',
    countMode: typeof rec.countMode === 'string' ? rec.countMode : 'BOARD',
    countsHand: rec.countsHand === true,
    countsGoldenOnly: rec.countsGoldenOnly === true,
    activeType: typeof rec.activeType === 'string' ? rec.activeType : 'BATTLE',
    isActiveInDeck: rec.isActiveInDeck === true,
    noStack: rec.noStack === true,
    maxInactiveBondCount: Number.isInteger(rec.maxInactiveBondCount) ? rec.maxInactiveBondCount : -1,
    layerMilestones: Array.isArray(rec.layerMilestones) ? [...rec.layerMilestones] : [],
    desc: typeof rec.desc === 'string' ? rec.desc : '',
    effectId: typeof rec.effectId === 'string' ? rec.effectId : '',
    effectName: typeof rec.effectName === 'string' ? rec.effectName : '',
    effectDesc: typeof rec.effectDesc === 'string' ? rec.effectDesc : '',
    effectDescParams: Array.isArray(rec.effectDescParams) ? [...rec.effectDescParams] : [],
    bb,
    bbStr: isPlainObj(rec.bbStr) ? { ...rec.bbStr } : {},
    baseParams: Array.isArray(rec.baseParams) ? [...rec.baseParams] : [],
    perStackParams: Array.isArray(rec.perStackParams) ? [...rec.perStackParams] : [],
    genericBuffs: rec.genericBuffs === true,
  };
  return spec;
}

/**
 * 校验一条盟约记录（工坊写出来的、或手写的）—— 返回这一层能看到的全部问题，`[]` 不代表绝对正确。
 * @param {object} rec
 * @param {{ id?: string, officialIds?: Set<string>|string[], engineIds?: Set<string>|string[] }} [opts]
 *   `officialIds` 是「这条 id 已经在官方数据里」——除非本包声明了覆盖，那是 OFFICIAL_ID_COLLISION；
 *   `engineIds` 是「引擎里逐条实现过的官方盟约」——它决定「没有 genericBuffs 就没有战斗加成」这条要不要报。
 * @returns {Array<{ field: string, code: string, message: string, hint?: string, severity: 'error'|'warning' }>}
 */
export function validateBondRecord(rec, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  if (!isPlainObj(rec)) { err('', 'NOT_AN_OBJECT', 'record must be a JSON object'); return out; }
  const id = opts.id ?? rec.bondId;
  if (!looksLikeBondId(id)) err('bondId', 'BAD_ID', `"${id}" is not a usable bond id`);
  if (rec.bondId !== undefined && rec.bondId !== id) err('bondId', 'ID_MISMATCH', `bondId "${rec.bondId}" does not equal its key "${id}"`);
  const official = opts.officialIds instanceof Set ? opts.officialIds : new Set(opts.officialIds || []);
  // 引擎里逐条实现的那批 id（官方 23 条）：覆盖官方盟约时，它的效果由官方处理器负责，所以不该报「没有实现」。
  const engine = opts.engineIds instanceof Set ? opts.engineIds : new Set(opts.engineIds || []);
  if (official.has(id)) {
    err('bondId', 'OFFICIAL_ID_COLLISION', `"${id}" already exists in the official data`,
      `replace it only on purpose: add "bonds:${id}" to the pack's overrides`);
  }
  if (typeof rec.name !== 'string' || !rec.name.trim()) err('name', 'MISSING', 'name is required');
  if (!BOND_COUNT_MODES.includes(rec.countMode)) err('countMode', 'BAD_ENUM', `countMode must be one of ${BOND_COUNT_MODES.join(', ')}`);
  if (!BOND_THRESHOLD_TEMPLATES.includes(rec.thresholdTemplate)) err('thresholdTemplate', 'BAD_ENUM', `thresholdTemplate must be one of ${BOND_THRESHOLD_TEMPLATES.join(', ')}`);
  if (!BOND_ACTIVE_TYPES.includes(rec.activeType)) err('activeType', 'BAD_ENUM', `activeType must be one of ${BOND_ACTIVE_TYPES.join(', ')}`);
  const th = Array.isArray(rec.thresholds) ? rec.thresholds : null;
  if (!th || !th.length) err('thresholds', 'MISSING', 'thresholds needs at least one positive integer');
  else {
    for (const n of th) if (!Number.isInteger(n) || n < 1) err('thresholds', 'BAD_NUMBER', 'every threshold must be an integer >= 1');
    for (let i = 1; i < th.length; i++) if (th[i] <= th[i - 1]) err('thresholds', 'NOT_ASCENDING', 'thresholds must be strictly ascending');
    if (rec.activeCount !== th[0]) err('activeCount', 'MISMATCH', `activeCount ${rec.activeCount} must equal the first threshold ${th[0]}`, 'the editor derives it');
  }
  if (!isFin(rec.weight) || rec.weight < 0) err('weight', 'BAD_NUMBER', 'weight must be a number >= 0');
  if (rec.weight === 0) warn('weight', 'NEVER_BANNED', 'weight 0 means this bond is never drawn into the 本局禁用 set');
  if (!Array.isArray(rec.members)) warn('members', 'MISSING', 'members is missing: the bond popup lists no members');
  if (rec.effectId === null || rec.effectId === undefined) warn('effectId', 'NO_EFFECT', 'no effectId: 效果说明 still shows, but no effect record is attached');
  if (!isPlainObj(rec.bb) || !Object.keys(rec.bb).length) warn('bb', 'NO_BB', 'no blackboard numbers: neither the official handler nor the generic one has anything to read');
  if (rec.genericBuffs === true && !Object.keys(rec.bb || {}).some((k) => GENERIC_BB_KEYS.includes(k))) {
    warn('genericBuffs', 'NO_GENERIC_KEYS', `genericBuffs is on but no ${GENERIC_BB_KEYS.join(' / ')} is set: nothing happens in battle`);
  }
  if (rec.genericBuffs !== true && !official.has(id) && !engine.has(id)) {
    warn('genericBuffs', 'NO_IMPLEMENTATION', 'this is a NEW bond and genericBuffs is off: it has no battle effect at all (only counting / bans / UI)');
  }
  return out;
}

/** 只要 error 级问题（与 chessAuthoring.authoringErrors 同名同义）。 */
export const bondErrors = (issues) => (Array.isArray(issues) ? issues : []).filter((i) => i.severity === 'error');

/** 一行一条的中文摘要（CLI / 日志用）。 */
export function formatBondIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i) => `${i.severity === 'error' ? '✘' : '⚠'} ${i.field || '(record)'} [${i.code}] ${i.message}${i.hint ? ` — ${i.hint}` : ''}`)
    .join('\n');
}

/** 阈值阶梯的人话：`2 / 4 / 6 名`；没有阈值时返回空串。 */
export function thresholdLine(thresholds) {
  const list = Array.isArray(thresholds) ? thresholds.filter((n) => Number.isInteger(n) && n > 0) : [];
  return list.length ? list.map((n) => `${n} 名`).join(' / ') : '';
}

/** 通用加成的人话（预览用）：`攻击力 +10% +1%/层`；什么都没写返回空串。 */
export function genericBonusLine(bb) {
  const src = isPlainObj(bb) ? bb : {};
  const parts = [];
  const one = (label, baseKey, perKey) => {
    const base = isFin(src[baseKey]) ? src[baseKey] : 0;
    const per = isFin(src[perKey]) ? src[perKey] : 0;
    if (!base && !per) return;
    const pct = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 1000) / 10}%`;
    parts.push(`${label} ${pct(base)}${per ? ` ${pct(per)}/层` : ''}`);
  };
  one('攻击力', 'base_atk', 'atk_per_stack');
  one('防御力', 'base_def', 'def_per_stack');
  one('生命上限', 'base_max_hp', 'max_hp_per_stack');
  return parts.join(' · ');
}

/** 这个盟约在战斗里到底会不会加东西：给界面上「会 / 不会」那行用。 */
export function battleEffectVerdict(rec, { isOfficialId = false } = {}) {
  if (!isPlainObj(rec)) return { kind: 'none', text: '没有记录' };
  if (isOfficialId) {
    return { kind: 'official', text: '官方盟约：效果由引擎里逐条实现，数值从这条记录读 —— 改 bb 立刻生效' };
  }
  if (rec.genericBuffs === true && Object.keys(rec.bb || {}).some((k) => GENERIC_BB_KEYS.includes(k))) {
    return { kind: 'generic', text: '新盟约：走通用加成（按 bb 的 base_*/*_per_stack 给成员加百分比）' };
  }
  return { kind: 'none', text: '新盟约且没有通用加成：只有计数、阈值、禁用抽签与界面，战斗里不加任何东西' };
}

/** 默认攻击范围（盟约本身没有范围；导出给「这个模块与干员共用同一份常量」的测试用）。 */
