// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered) — as a player (加入同盟) or in one of its MAX_SPECTATORS
// spectator seats (观战: room.spectate, also while its match runs; community report #26, a remake feature — the
// official room has none). Shows connection status + ping.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).
// Texts go through t() (docs/I18N.md); the module-level tables hold msgids (N_) translated where they are shown, the
// config.json mode texts come localized from data.js.

import { ResumeMatchButton } from '../ui/resumeMatch.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MIN_SEATS, MAX_SPECTATORS, modeIdFor, clampSeats, ERR } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo } from '../ui/components.js';
import { Modal } from '../ui/components.js';
import { useHubBackdrop, HubBackdrop, HubRadar, BackdropSettings, BackdropGlyph, backdropTheme } from '../ui/hubBackdrop.js';
import { usePresence } from '../ui/transitions.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { PwaInstallButton } from '../ui/device.js';
import { LoadoutButton } from './loadout.js';
import { DEFAULT_DIFFICULTY, parsePlaytestParam } from './lobbyLinks.js';
import { SweepReport } from './sweep.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { RadarScene, CreateArt, JoinArt } from '../ui/matchFlow.js';
import { SupportButton } from './support.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import * as roomMods from '../roomMods.js';
import { getConfig, getMode, getStage, useData } from '../data.js';
import { t, tc, N_ } from '../../../shared/i18n.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: N_('时长较短的模拟训练'), effects: [N_('可以快速完成作战'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: N_('敌方攻击强度较低的模拟训练'), effects: [N_('作战环境较为温和'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * From the data name only its 战场#NN part (with a (上半) / (下半) mark) — 'Battlefield #NN (First Half)' in English.
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) {
    const m = rec.name.match(/^(.*?#\d+(?:\s*[(（][^)）]*[)）])?)/);
    return m ? m[1] : rec.name.split(/\s+/)[0];
  }
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? t('战场#{no}', { no: String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0') }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? t('战场固定为 {name}', { name }) : t('战场固定'); }
    return ids.length > 1 ? t('战场随机（共{n}张）', { n: ids.length }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? t('战场随机（共{stages}张）', { stages }) : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: N_('独立模拟'), en: 'SOLO SIMULATION', icon: 'user',
    desc: N_('独自调配资金与干员，以自己的节奏完成整场模拟。'),
    points: [N_('1 名博士'), N_('休整期与机变阶段不限时')],
  },
  {
    id: 'coop', name: N_('同盟模拟'), en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: N_('与至多 {n} 名博士组成同盟，共享干员池，联防协作抵御敌潮。'), params: { n: MAX_SEATS - 1 },
    points: [N_('1–{n} 名博士 · 可由 AI 队友补位'), N_('联防阶段 · 最终攻势合并生命值')], pointParams: { n: MAX_SEATS },
    // ↑ 这两处 `params` 只是**兜底**（= 官方 4 座那一档：3 与 4）：render 时按这台服务器的上限（缺省 20）重算
    //   —— 19 与 20（见 ModeCard，业主裁令 2026-10-12）。msgid 与参数名一个都没动，四个语言包照旧。
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•・･\s]+/, '')).filter(Boolean)
    : fallback.effects.map((e) => t(e));
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : t(fallback.desc),
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

// 地基加固（B 方案 · 2026-10-13）：`DEFAULT_DIFFICULTY` 与 `parsePlaytestParam` 现在住在 screens/lobbyLinks.js，
// 这里保留同一份绑定并**原样转发导出** —— screens/playtestLink.js 与 test/playtestLink.test.js 都从本模块导入这两个
// 名字（main.js 静态 import playtestLink.js，链接断掉整个客户端白屏），所以本模块的导出面不许变。
// 为什么搬走：本文件正按 ui-hub 包的新结构逐段并进来；把链接面放进独立文件，改观感就碰不到它。
// 包版 `payload/public/js/screens/lobby.js` 里这两个符号是 0 处 —— 这正是「整份装包会白屏」的原因之一。
export { DEFAULT_DIFFICULTY, parsePlaytestParam };

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  N_('联合模拟在选择策略时可以进行一次跳过'),
  N_('调度中心即使冻结，依然可以主动刷新'),
  N_('两件同名装备可以合成一件更强力的装备'),
  N_('只有达成完美作战的队友可以进行联防'),
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const fallback = FALLBACK_TIPS.map((x) => t(x));
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((x) => (typeof x === 'string' ? x : x?.tip)).filter((x) => typeof x === 'string' && x)
    : fallback;
  const list = tips.length ? tips : fallback;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>${t('作战提示')}</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label=${t('上一条')}><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label=${t('下一条')}><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}

function ModeCard({ card, selected, onSelect }) {
  // 座位数文案 (业主裁令 2026-10-12): the ceiling is THIS server's (`welcome.maxSeats`), not the official 4 — a 20-seat
  // server's card must not still promise 「至多 3 名博士」. The number is read at render time, so a `welcome` that lands
  // after the module was evaluated (or a reconnect that changes servers) is reflected; the msgid and its `{n}` params
  // are unchanged (only the VALUE moves), so every i18n pack keeps working.
  const seats = card.id === 'coop' ? serverSeatMaxOf() : MAX_SEATS;
  const params = card.id === 'coop' ? { n: Math.max(1, seats - 1) } : card.params;
  const pointParams = card.id === 'coop' ? { n: seats } : card.pointParams;
  return html`<button type="button" class=${`mode-card brackets${selected ? ' is-selected' : ''}`} onClick=${() => onSelect(card.id)}
      aria-pressed=${selected ? 'true' : 'false'}>
    <span class="mode-card__bg" aria-hidden="true"></span>
    <span class="mode-card__icon"><${Icon} name=${card.icon} /></span>
    <span class="mode-card__text">
      <${MicroLabel} tone=${selected ? 'mint' : undefined}>${card.en}<//>
      <span class="mode-card__name">${t(card.name)}</span>
      <span class="mode-card__desc">${t(card.desc, params)}</span>
      <span class="mode-card__points">${card.points.map((p) => html`<span key=${p}>${t(p, pointParams)}</span>`)}</span>
    </span>
    <span class="mode-card__check" aria-hidden="true"><${Icon} name="check" />${t('已选定')}</span>
  </button>`;
}

function DifficultyCard({ roomMode, difficulty, selected, onSelect }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> ${tc('rounds', '回合')}${info.hidden ? html`<span class="diff-card__hidden">${t('+ 隐秘核心')}</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>${t('已选定')}</span></span>
  </button>`;
}

/** One-line name of a pack's layer (DESIGN §28.1): what kind of content the pack brings. */
export const LAYER_TEXT = { A: N_('数据'), B: N_('逻辑'), C: N_('客户端') };

// ---------------------------------------------------------------------------------------------------
// 本房座位上限 (业主裁决 B5, docs/META.md §1.9): the host's seat slider
// ---------------------------------------------------------------------------------------------------

/**
 * The seat ceiling THIS server allows, as `welcome.maxSeats` announced it.
 *
 * The number travels in the handshake (server/lobby.js `welcomeInfo`) on EVERY handshake — the server's default ceiling
 * is 20 (业主裁令 2026-10-12), not the official `MAX_SEATS`, so there is no "vanilla" case left to omit it for. The
 * lobby reads it HERE, at module scope, because the handshake happens before this screen is ever mounted (main.js
 * imports the screens eagerly, the socket connects in `boot()`): a first `welcome` would otherwise be missed and the
 * slider would keep offering 4 on a 20-seat server. A reconnect re-announces it, so the cache follows the server it is
 * actually talking to.
 *
 * Unusable / absent ⇒ the client keeps the OFFICIAL 4: a server too old to send the field is an official-room server,
 * and assuming 4 can only ever ask for FEWER seats than it allows.
 */
let serverSeatMax = MAX_SEATS;

/** @returns {number} the ceiling the lobby's seat slider may reach (never below 1) */
export function serverSeatMaxOf() { return serverSeatMax; }

net.on('welcome', (msg) => {
  const n = msg ? msg.maxSeats : undefined;
  serverSeatMax = Number.isInteger(n) && n >= 1 ? n : MAX_SEATS;
});

/** The slider's range for a ceiling: `max` is the server's, `min` the floor (narrowed if the server is below it). */
export function seatCapRange(serverMax) {
  const max = Number.isInteger(serverMax) && serverMax >= 1 ? serverMax : MAX_SEATS;
  return { min: Math.min(MIN_SEATS, max), max };
}

/**
 * What `room.create` should carry for a pick — `{}` whenever the room is built the way it always was.
 *
 * Two deliberate silences: a SOLO room never carries the field (its one-seat shape is `mode: 'solo'`'s, and the server
 * ignores it there anyway), and a pick that equals the server's ceiling sends NOTHING — that is 「本房不另设上限」,
 * i.e. the pre-B5 payload and the pre-B5 room, byte for byte. Only a pick BELOW the ceiling is a real choice.
 *
 * `clampSeats` is the same shared rule the server applies, so the client cannot send a value the server would refuse
 * (`shared/protocol.js`: outside `[MIN_SEATS, SEAT_CAP]` ⇒ `BAD_MSG`).
 */
export function seatCapPayload(mode, pick, serverMax) {
  if (mode !== 'coop') return {};
  const { max } = seatCapRange(serverMax);
  const cap = clampSeats(pick, max);
  return cap === max ? {} : { seatCap: cap };
}

/**
 * 房主决定本同盟开几张座位卡 (业主裁决 B5): a range input, with the current value, the server's ceiling and the two
 * ends spelled out. **Only rendered for co-op** (a solo room has no seat count to choose) and only when the range has
 * something to choose (`max > min`) — on a server whose ceiling is the floor there is nothing to pick, so the picker
 * disappears rather than showing a dead slider.
 *
 * This is the ONLY seat-cap surface: it lives in the lobby (which is a host's screen), never in the room screen, where
 * the cap is already fixed and `room.state.seatCap` merely describes it.
 * @param {{ value: number, min: number, max: number, onChange: (n: number) => void }} props
 */
function SeatCapPicker({ value, min, max, onChange }) {
  if (!(max > min)) return null;
  const pct = Math.round(((value - min) / (max - min)) * 100);
  return html`<div class="seat-cap">
    <div class="seat-cap__head">
      <${MicroLabel} tone="mint">SEATS<//>
      <span class="seat-cap__name">${t('本房间人数上限')}</span>
      <span class="seat-cap__value num">${value}<span class="t-dim"> / ${max}</span></span>
    </div>
    <input class="seat-cap__slider" type="range" min=${min} max=${max} step="1" value=${value}
      style=${`--pct:${pct}%`} aria-label=${t('本房间人数上限')}
      aria-valuemin=${min} aria-valuemax=${max} aria-valuenow=${value}
      onInput=${(e) => onChange(Number(e.currentTarget.value))} />
    <div class="seat-cap__note">${t('服务器允许最多 {max} 人；本同盟开 {value} 张座位卡', { max, value })}</div>
  </div>`;
}

/**
 * 本房间使用 mod (W-A, DESIGN §28.9): the host ticks the packs THIS server declared, and the pick travels as
 * `room.create.modIds`. The list comes from `welcome.mods.packs` (main.js writes it into store.roomMods), so it can only
 * ever offer content the server has — the server refuses an unknown id with MOD_UNKNOWN rather than guessing.
 *
 * Rendered only when the server declared at least one pack; on a plain install this component returns nothing and the
 * create button sends exactly what it always did.
 */
function ModPicker({ selected, onToggle }) {
  const { available } = useStore((s) => s.roomMods, shallowEqual);
  if (!available.length) return null;
  return html`<div class="mod-picker">
    <div class="mod-picker__head">
      <${MicroLabel} tone="mint">ROOM MODS<//>
      <span>${t('本房间使用的模组')}</span>
    </div>
    <ul class="mod-picker__list">
      ${available.map((p) => html`<li key=${p.id}>
        <button type="button" class=${`mod-chip${selected.includes(p.id) ? ' is-on' : ''}`}
          aria-pressed=${selected.includes(p.id) ? 'true' : 'false'} onClick=${() => onToggle(p.id)}>
          <span class="mod-chip__id">${p.id}</span>
          <span class="mod-chip__meta">${t(LAYER_TEXT[p.layer] || p.layer)}${p.combat ? ` · ${t('会改动战斗结果')}` : ''}</span>
        </button>
      </li>`)}
    </ul>
    <div class="mod-picker__note">${t('不勾选 = 本房间不声明模组（模拟仍按服务器加载的全部模组运行）')}</div>
  </div>`;
}

/**
 * 野排匹配 (quick match, `room.queue` / `room.dequeue`; server/matchmaking.js, docs/META.md §1.6). The panel is the
 * waiting state: how many others are searching, how many are needed, how long is left, and the cancel button.
 *
 * `queue` is the last `room.queued` frame the screen saw ('waiting' only — 'placed' / 'timeout' / 'cancelled' end the
 * panel; main.js routes into the room on the `room.state` that follows a 'placed'). Every text goes through t().
 * @param {{ queue: any, busy: string|null, onCancel: () => void }} props
 */
function QuickMatchPanel({ queue, busy, onCancel }) {
  const left = Math.max(0, Math.ceil(((queue.deadline || 0) - Date.now()) / 1000));
  return html`<${Panel} class="quickmatch-panel" tone="mint">
    <div class="quickmatch-row">
      <${Spinner} size="sm" label="SEARCHING" />
      <span class="quickmatch-text">${t('正在搜寻队友…')}</span>
      <span class="quickmatch-count num">${queue.size}/${queue.need}</span>
    </div>
    <div class="quickmatch-foot">
      <span class="t-dim">${t('等待中的第 {position} 位 · 还需 {need} 名博士 · 剩余 {left} 秒', { position: queue.position, need: queue.need, left })}</span>
      <${Button} variant="secondary" size="sm" loading=${busy === 'dequeue'} onClick=${onCancel}>${t('取消搜寻')}<//>
    </div>
  <//>`;
}

// ---- S.W.E.E.P.报告 入口 (ui-hub-package-20261013, screens/sweep.js) -----------------------------------------------
// 包版把这个入口画在它自己的「hub 板块」栏里 (ui-hub-package-20261013 的 screens/lobby.js SweepPlate); 本轮按
// 裁定的 (甲) 路线做「只加不改」: 入口按钮挂在引擎顶栏的工具排里, 报告浮层挂在屏幕末尾, 引擎既有行一行不动。
// 样式直接复用: sweep.js 与它的 .sw-* 规则、.hub-plate--sweep 的规则都在第 2 步那次提交里已经进仓库。

/** S.W.E.E.P.报告的徽记: 正六边形 + 交叉的双剑 (取自包版 screens/lobby.js SweepGlyph, 未改动一字)。 */
function SweepGlyph() {
  return html`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2z" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M9 9l12.5 12.5M23 9 10.5 21.5" stroke="currentColor" stroke-width="2.2" />
    <path d="M19.2 23.8l4.6-4.6M8.2 19.2l4.6 4.6M21.6 21.6l2.2 2.2M10.4 21.6l-2.2 2.2" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

/**
 * 顶栏的 S.W.E.E.P.报告按钮: 打开 screens/sweep.js 的报告浮层 (盟约报告 / 策略报告 / 敌方资料)。
 * @param {{ onClick: () => void }} props
 */
function SweepEntry({ onClick }) {
  return html`<${Button} variant="secondary" square=${true} class="lobby-sweep" onClick=${onClick}
    title=${t('S.W.E.E.P.报告：盟约、策略与敌方资料')} aria-label=${t('S.W.E.E.P.报告：盟约、策略与敌方资料')}><${SweepGlyph} /><//>`;
}

/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  // The host's picks for the room it is about to create (store.roomMods, written by main.js from `welcome.mods`). The
  // values themselves live in roomMods.js; this slice is only what the picker renders and re-renders from.
  const selectedMods = useStore((s) => s.roomMods.selected, shallowEqual);
  useData('config');
  const [roomMode, setRoomMode] = useState(() => (loadPref('lobby.mode', 'coop') === 'solo' ? 'solo' : 'coop'));
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', DEFAULT_DIFFICULTY);
    return DIFFICULTIES.includes(d) ? d : DEFAULT_DIFFICULTY;
  });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  // 本房座位上限 (业主裁决 B5): `seatMax` = the ceiling this server announced, `seatPick` = the host's move of the
  // slider. `null` means "not moved": the pick then IS the ceiling, which is the pre-B5 room and sends no field at all
  // (`seatCapPayload`). Keeping the ceiling in state (not a module read at render time) is what makes a reconnect that
  // announces a different ceiling actually re-render the slider.
  const [seatMax, setSeatMax] = useState(() => serverSeatMaxOf());
  const [seatPick, setSeatPick] = useState(null);
  const seatRange = seatCapRange(seatMax);
  const seatValue = seatPick == null ? seatRange.max : clampSeats(seatPick, seatRange.max);
  // 野排匹配: the last `room.queued` frame WHILE we are still waiting (null = not in the queue). 'placed' / 'timeout' /
  // 'cancelled' clear it: the first is followed by the room.state that routes into the room, the other two mean the
  // server already took us out of the queue.
  const [queue, setQueue] = useState(null);
  const [recent] = useState(recentRooms);
  // S.W.E.E.P.报告浮层是否打开 (screens/sweep.js); 只在本地, 不落 pref —— 它是一次查看, 不是设置。
  const [sweepOpen, setSweepOpen] = useState(false);
  // 大厅背景 (ui/hubBackdrop.js): pref + 自定义图片的 object URL + 设置对话框的动作; bgOpen 是「大厅背景」对话框的开关。
  // 这一层是纯新增的装饰层, 大厅的既有结构、五件独有功能与 mod 面一行都不碰。
  const bg = useHubBackdrop();
  const [bgOpen, setBgOpen] = useState(false);
  // 大厅背景对话框的离场 (ui/transitions.js usePresence): 引擎的 Modal 是「open=false 即卸载」,没有离场动画;
  // usePresence 把 show=false 后的这一段(220ms)保持挂载,Modal 自带的 .modal.is-leaving 由它的 css 播完再收。
  // 纯新增:bgOpen 本身仍是唯一状态源,这里只是把「卸载」推迟到动画之后。
  const [bgShown, bgLeaving] = usePresence(bgOpen);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    // The queue is server state: the only place this screen learns it is the frame the server pushes. A timeout is
    // worth a toast (the player must know the search ended); a placement needs nothing — main.js already moved on.
    return net.on('room.queued', (msg) => {
      if (!alive.current) return;
      if (msg.status === 'waiting') { setQueue(msg); return; }
      setQueue(null);
      if (msg.status === 'timeout') toast(t('快速匹配超时：没有等到足够的博士，请稍后再试'), 'warn');
    });
  }, []);
  useEffect(() => {
    // 本房座位上限 (业主裁决 B5): the slider mirrors the CURRENT server. The module-scope listener above keeps the cache
    // fresh while this screen is unmounted (the handshake usually lands on the title screen), and this one syncs the
    // mounted component — including a reconnect that announces a different ceiling.
    const sync = () => { if (alive.current) setSeatMax(serverSeatMaxOf()); };
    sync();
    return net.on('welcome', sync);
  }, []);

  const online = conn.status === 'online';
  const codeOk = CODE_RE.test(code);

  const pickMode = (m) => { setRoomMode(m); savePref('lobby.mode', m); };
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };
  /** Tick/untick one pack for the next room: roomMods owns the list (it drops ids the server no longer declares). */
  const toggleMod = (id) => {
    const next = roomMods.getSelectedModIds();
    const at = next.indexOf(id);
    if (at >= 0) next.splice(at, 1); else next.push(id);
    const kept = roomMods.setSelectedModIds(next);
    store.set({ roomMods: { ...store.get().roomMods, selected: kept } });
  };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  // 本房座位上限 (业主裁决 B5): the host's own cap rides along only when it is a real choice — an untouched slider (and
  // every solo room) adds no key, so this request is the one this client always sent.
  const create = () => run('create', () => net.request('room.create', {
    ...roomMods.buildCreatePayload(roomMode, difficulty),
    ...seatCapPayload(roomMode, seatValue, seatMax),
  }));
  // 野排匹配: enter the queue with the difficulty cards' pick (the server refuses `solo` — a queue of strangers forms a
  // co-op room; the button is hidden for 独立模拟). `mods` is the same digest gate `room.create` carries, so a modded
  // server still checks that we know what we are joining; `modIds` is deliberately NOT sent — a quick-matched room runs
  // the server's default set (docs/META.md §1.6), never a subset this client picked for some other room.
  const quickMatch = () => run('queue', async () => {
    const set = roomMods.currentModSet();
    const payload = { mode: 'coop', difficulty, ...(set ? { mods: set.digest } : {}) };
    await net.request('room.queue', payload, { timeout: 20000 });
    // Only a reply that was actually `ok` reaches this line (`run` shows the error otherwise — QUEUE_FULL included).
    // The server's own `room.queued` frame follows for a real queue; until it does, the panel shows the one frame the
    // protocol lets a client assume. A placement clears it again through the listener above.
    // 排队人数占位用**官方一间房**（`MAX_SEATS` 4），不是服务器上限：快速匹配的 `size` 是 `MATCHMAKE_DEFAULTS.size`
    // 的一间官方房，**不跟随 `SP_MAX_SEATS`**（业主裁令 2026-10-12），而真正的 `need` 由服务端的 `room.queued` 覆盖。
    if (alive.current) setQueue((q) => q || { status: 'waiting', position: 1, size: 1, need: MAX_SEATS, deadline: Date.now() + 120000 });
  });
  const cancelQueue = () => run('dequeue', async () => {
    await net.request('room.dequeue', {});
    if (alive.current) setQueue(null);
  });
  const join = (c = code) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('join', () => net.request('room.join', roomMods.buildJoinPayload(k)));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(t('没有找到密钥 {k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）', { k }), 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast(t('你已经是该同盟的博士：先离开同盟，才能以观战身份进入'), 'warn');
        return;
      }
      throw err;
    }));
  };
  const backToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };

  return html`<div class="screen lobby-screen" data-hub-theme=${backdropTheme(bg)}>
    <${HubBackdrop} bg=${bg} />
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title=${t('返回标题')}>${t('返回')}<//>
        <${PingPill} ms=${conn.ping} online=${online} />
        <span class="topbar__sep" aria-hidden="true"></span>
        <div class="topbar__tools">
          <${SettingsButton} class="lobby-settings" variant="secondary" square=${true} />
          <${GuideButton} class="lobby-guide" variant="secondary" square=${true} />
          <${SweepEntry} onClick=${() => setSweepOpen(true)} />
          <${Button} variant="secondary" size="sm" square=${true} class="hub-bg-btn" onClick=${() => setBgOpen(true)}
            title=${t('大厅背景')} aria-label=${t('大厅背景')}><${BackdropGlyph} /><//>
          <${PwaInstallButton} class="lobby-pwa" square=${true} />
        </div>
      </div>
      <div class="topbar__center">
        <${HubRadar} bg=${bg} />
        <${MicroLabel} tone="mint">SIMULATION PROTOCOL SELECT<//>
        <h1 class="topbar__title">${t('选择模拟协议')}</h1>
        <section class="lobby-proto-stage" style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} aria-hidden="true">
          <${ProtocolScene} key=${difficulty} difficulty=${difficulty} />
        </section>
      </div>
      <div class="topbar__right">
        <${ResumeMatchButton} />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" label=${t('干员调配')} />
        <${SupportButton} from="lobby" size="sm" class="lobby-support" />
        <button type="button" class="me-chip me-chip--btn stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')}>
          <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
          <span class="me-chip__text">
            <span class="me-chip__name">${me.name || t('博士')}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </span>
          <${Icon} name="chart" class="me-chip__stats" />
        </button>
      </div>
    </header>

    <div class="lobby-body screen__scroll">
      <section class="lobby-left">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('模拟方式')}<${MicroLabel}>MODE<//></div>
        <div class="mode-cards">
          ${MODE_CARDS.map((c) => html`<${ModeCard} key=${c.id} card=${c} selected=${roomMode === c.id} onSelect=${pickMode} />`)}
        </div>

        <div class="section-label"><span class="section-label__idx num">03</span>${t('加入同盟')}<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
        <${Panel} class="join-panel" tone="amber">
          <div class="join-row">
            <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
              transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
            <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>${t('加入同盟')}<//>
            <${Tooltip} text=${t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })}>
              <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online} onClick=${spectate}>${t('观战')}<//>
            <//>
          </div>
          <div class="join-foot">
            ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
              ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
                onClick=${() => setCode(c)}>${c}</button>`)}`
              : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
          </div>
        <//>
        <div class="hub-art" aria-hidden="true"><${JoinArt} /></div>
        <div class="hub-radar-art" aria-hidden="true"><${RadarScene} /></div>
        <${TipsPanel} />
      </section>

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${pickDifficulty} />`)}
        </div>
        <div class="create-box">
          <${ModPicker} selected=${selectedMods} onToggle=${toggleMod} />
          ${roomMode === 'coop'
            ? html`<${SeatCapPicker} value=${seatValue} min=${seatRange.min} max=${seatRange.max} onChange=${setSeatPick} />`
            : null}
          <${Tooltip} block=${true} text=${online ? null : t('正在连接服务器…')}>
            <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!online} onClick=${create}>
              ${roomMode === 'solo' ? t('开始独立模拟') : t('创建同盟')}
            <//>
          <//>
          ${queue
            ? html`<${QuickMatchPanel} queue=${queue} busy=${busy} onCancel=${cancelQueue} />`
            : roomMode === 'coop'
              // No threshold in this label: the queue size is the SERVER's setting (`queue.size`) and the client cannot
              // read the deployment's options — the waiting panel above shows the real numbers once it is queued.
              ? html`<${Tooltip} block=${true} text=${t('和陌生人组队：等待的博士凑够人数即自动建房（本房间按服务器默认模组运行）')}>
                  <${Button} variant="secondary" size="lg" block=${true} icon="users" loading=${busy === 'queue'} disabled=${!online} onClick=${quickMatch}>
                    ${t('快速匹配')}
                  <//>
                <//>`
              : null}
          <div class="create-box__hint">
            ${online
              ? html`<span>${roomMode === 'solo' ? t('创建后即可开始模拟') : t('创建后可邀请好友或添加 AI 队友')}</span>`
              : html`<${Spinner} size="sm" label="CONNECTING" />`}
          </div>
          <div class="hub-art" aria-hidden="true"><${CreateArt} /></div>
        </div>
      </section>
    </div>
    ${sweepOpen ? html`<${SweepReport} onClose=${() => setSweepOpen(false)} />` : null}
    <${Modal} open=${bgOpen || bgShown} class=${bgLeaving ? 'is-leaving' : ''} micro="LOBBY BACKDROP" title=${t('大厅背景')} onClose=${() => setBgOpen(false)}>
      <${BackdropSettings} bg=${bg} />
    <//>
  </div>`;
}
