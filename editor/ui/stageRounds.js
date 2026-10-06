// editor/ui/stageRounds.js — 地图页「回合绑定」的纯逻辑：把出怪表绑到回合上。
//
// 为什么要有它：真正决定「这一回合出什么怪」的是**地图自己的 `rounds`**（引擎先看这张图、再看模式的模板，
// server/match/waves.js 的 stageTemplateId）。而此前这条链路的最后一环没有界面 —— 作者能做出出怪表，
// 却只能手改地图 spec 的 JSON 才能让它生效；出怪页那个「绑定到回合」写的是 `usedBy`，引擎**从来不读**。
//
// 另一个坑是「写错的 id 不报错」：引擎解析不到就**静默回落到模式的模板**，于是作者以为自己绑上了、
// 实际打的是官方那一套。校验器只查形状（是不是字符串），所以「这个 id 到底存不存在」只能由界面自己查。
//
// 这里只做纯计算（不碰 DOM），界面负责画。

/** 读取绑定值：spec 里允许 `"wave_id"` 或 `{ template: "wave_id" }` 两种写法（引擎两者都认）。 */
export function boundWaveOf(value) {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object' && typeof value.template === 'string') return value.template || null;
  return null;
}

/** 这张图要按哪些模式来列回合：优先它自己勾选的模式，否则给全部（不然新建地图时面板是空的）。 */
export function modeIdsOf(spec, roundBind) {
  const all = Object.keys(roundBind?.modes ?? {});
  const own = Array.isArray(spec?.modes) ? spec.modes.filter((m) => all.includes(m)) : [];
  return own.length ? own : all;
}

/**
 * 一行 = 一个回合。回合数取所选模式里的最大值（模式之间回合数不同，比如 9 与 15），
 * 这样「这张图在深渊模式下的第 12 回合」也能绑。
 * @param {object} spec 地图 spec
 * @param {{modes?: Record<string, {name?:string, rounds?:Array<{round:number,template?:string,isBoss?:boolean}>, bosses?:string[]}>}} roundBind 服务端给的回合表
 * @returns {Array<{round:number, isBoss:boolean, defaults:Array<{modeId:string,mode:string,template:string|null}>, bound:string|null, bossBound:string|null, bossKeys:string[]}>}
 */
export function roundRows(spec, roundBind) {
  const ids = modeIdsOf(spec, roundBind);
  const mods = ids.map((id) => ({ id, ...(roundBind?.modes?.[id] ?? {}) }));
  const maxRound = mods.reduce((n, m) => Math.max(n, Array.isArray(m.rounds) ? m.rounds.length : 0), 0);
  const rows = [];
  for (let r = 1; r <= maxRound; r++) {
    const per = mods.map((m) => ({ modeId: m.id, mode: m.name ?? m.id, cell: (m.rounds ?? [])[r - 1] ?? null })).filter((x) => x.cell);
    const bossKeys = [...new Set(per.flatMap((x) => (x.cell.isBoss ? (mods.find((m) => m.id === x.modeId)?.bosses ?? []) : [])))].sort();
    const perRound = spec?.bossRounds?.[String(r)];
    rows.push({
      round: r,
      isBoss: per.some((x) => x.cell.isBoss),
      defaults: per.map((x) => ({ modeId: x.modeId, mode: x.mode, template: typeof x.cell.template === 'string' ? x.cell.template : null })),
      bound: boundWaveOf(spec?.rounds?.[String(r)]),
      bossBound: (perRound && typeof perRound === 'object') ? (Object.values(perRound).find((v) => typeof v === 'string') ?? null) : null,
      bossKeys,
    });
  }
  return rows;
}

/**
 * 绑了但**不存在**的出怪表 id。引擎遇到这种 id 会静默回落，所以界面必须把话说出来。
 * @returns {Array<{round:number, kind:'round'|'boss', id:string}>}
 */
export function missingBindings(spec, roundBind) {
  const known = new Set((roundBind?.waves ?? []).map((w) => w.id));
  const out = [];
  const check = (map, kind) => {
    for (const [key, value] of Object.entries(map ?? {})) {
      const id = boundWaveOf(kind === 'boss' ? (value && typeof value === 'object' ? Object.values(value)[0] : value) : value);
      if (id && !known.has(id)) out.push({ round: Number(key), kind, id });
    }
  };
  check(spec?.rounds, 'round');
  check(spec?.bossRounds, 'boss');
  return out.sort((a, b) => (a.round - b.round) || a.kind.localeCompare(b.kind));
}

/**
 * 写入一个普通回合的绑定，返回**新的** rounds 表（清空时返回 undefined，好让字段整个消失）。
 * @param {Record<string, string>|undefined} rounds 当前的 `spec.rounds`
 * @param {number} round
 * @param {string} waveId 空串表示「用模式的模板」
 */
export function setRoundBinding(rounds, round, waveId) {
  const next = { ...(rounds ?? {}) };
  const key = String(round);
  if (waveId) next[key] = waveId;
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/**
 * 写入首领回合的绑定：给该模式的**每个**首领 id 都写上同一个表。
 * 引擎按抽到的首领取（取不到就取该回合里第一个字符串值），所以全写上 = 抽到谁都走你的表。
 * @param {Record<string, Record<string, string>>|undefined} bossRounds 当前的 `spec.bossRounds`
 */
export function setBossRoundBinding(bossRounds, round, waveId, bossKeys = []) {
  const next = { ...(bossRounds ?? {}) };
  const key = String(round);
  if (waveId) next[key] = Object.fromEntries((bossKeys.length ? bossKeys : ['*']).map((b) => [b, waveId]));
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/** 下拉里的出怪表选项：官方在前、本包在后（各组内按 id 排），带中文名方便认。 */
export function waveOptions(roundBind) {
  const list = Array.isArray(roundBind?.waves) ? [...roundBind.waves] : [];
  /** 0 = 官方，1 = 本包：官方是「大家都认识的那几张」，放前面。 */
  const rank = (w) => (w.pack ? 1 : 0);
  return list
    .filter((w) => w && typeof w.id === 'string' && w.id)
    .sort((a, b) => (rank(a) - rank(b)) || String(a.pack ?? '').localeCompare(String(b.pack ?? '')) || a.id.localeCompare(b.id))
    .map((w) => ({ id: w.id, pack: w.pack ?? null, label: w.name && w.name !== w.id ? `${w.name} (${w.id})` : w.id }));
}
