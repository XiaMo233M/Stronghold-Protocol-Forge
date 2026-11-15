// Room screen (同盟等待室), laid out like the event's room: 4 tall seat cards (the 名片干员 portrait or the avatar frame,
// 创建者, the ready state at the bottom, the name plate under the card; an empty seat offers 邀请 — copies the key — and,
// to the host, 添加 AI 队友; the host's 移出 / 移除 AI 队友 at a card's top right), the top bar (leave, mode and ping, 统计 /
// 设置 / 玩法说明, 干员调配 and the 同盟密钥 with 复制 / the link), the bottom: the ready count and status line, the
// difficulty pill and ⚙ 同盟设置 (co-op; a timed solo's ⚙ is 模拟设置 and holds 「不限时」, DESIGN §37.23.10; the ⚙ sits where the event's pill has 快速搜寻 — matchmaking is dropped by the
// maintainer's PR #643 keep / drop list of 2026-10-15), and the big 开始模拟 / 准备就绪 button (its disabled reason in
// the project's Tooltip: hover, or a long press on touch; the status line says it too).
// Room settings: a co-op room is created at once from the lobby's 创建同盟 (the event's 联合模拟, research 06 §3.2; the
// maintainer's decision of 2026-10-21), so the difficulty is chosen here — the host's pill (or ⚙'s 模拟难度 row) opens
// 选择模拟协议 (screens/lobby.js ProtocolSelect) whose 确认 sends room.setDifficulty; the dialog closes only once the
// server took it (a refusal keeps it open with the error toast), and its hint states the server's rules: the other
// doctors have to ready again, a plugin mode the host chose is left. ⚙ 同盟设置 lists the 模拟难度 and the
// 「AI 队友最后选择」 switch. The other doctors (and spectators) open the same screens read-only — the cards shown,
// not chosen, 由创建者选择 / 由创建者设置 — and a toast tells them when the host changed the difficulty [ASSUMED: a
// remake aid, since the change reset their ready state; how the event tells the others is not recorded].
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// Plugins (DESIGN §32 P1a): the tag under the title — 「原版」 or 「插件 ×N」 — opens the 插件 panel (ui/pluginPanel.js:
// the host switches the room's plugins, everybody else reads them). With gameplay plugins (§32.6: a content set of its
// own — the tag reads 「非官方」 too) every seat shows whether its page has loaded and checked the room's content
// (seats[].content: 载入中 / 就绪 / 校验失败), 准备就绪 and 开始模拟 wait for it (the server refuses them before:
// CONTENT_NOT_READY), and a plugin mode the host chose shows beside the mode name in the top bar (the orange chip).
// 名片干员 (PR #643 split 6): a doctor's seat card shows an operator's portrait — the one the player picked (更换立绘 on
// one's own seat opens the picker: search, rarity, 默认; kept as a pref — ui/seatArt.js cardStore — and sent as
// room.card by ui/loadoutSync.js installCardSync, so the room sees it as seats[].card), else one of the 5★/6★ operators
// chosen by the player id (ui/seatArt.js), the same on every client. [ASSUMED] The pick made here and kept in this
// browser stands in for the event's account assistant (名片形象); [ASSUMED] the default by player id is a remake rule.
// Outfits (docs/SKINS.md; the maintainer's decision 4 of 2026-10-21): the portrait wears the player's outfit — one's own
// card this browser's choice at once, another doctor's the map that seat published (room.state seats[].skins) unless
// 「显示其他玩家的皮肤」 is off; an outfit this page's appearance plugins do not have draws the default art (ui/seatArt.js
// seatCardSkin). The picker is one's own picker, so its tiles wear one's own outfits too (like 干员调配's).
// Without the art pack the card keeps its avatar frame; a bot keeps its robot frame.
// Official versions (DESIGN §37.23, M1; versions.js): a room plays one version (room.state.version; absent = 第二期下半).
// Another version's name shows beside the mode in the top bar (ui/pluginTag.js VersionTag) and every page loads and checks
// its data like a gameplay plugin's content set (content.js) — the seat tags read 版本数据载入中 / 就绪 / 校验失败 and
// 准备就绪 / 开始模拟 wait for it (needsContent: gameplay plugins or another version; 非官方 stays the plugins' alone).
// The version pill beside the difficulty (and ⚙'s 版本 row in co-op) opens the version picker (ui/versionPicker.js): the
// host's pick proposes the switch (room.proposeVersion: a lone human's room switches at once; otherwise the seated humans
// vote — ui/versionVote.js, the strip between the 观战席 and the footer); everybody else reads it (由创建者发起). It is off
// during a vote, with gameplay plugins on (they play 第二期下半 only) and offline. A switch is told to everybody (a toast,
// never on entering a room), and a room whose version is not this browser's lobby choice says that leaving restores it.
// Texts go through t() (docs/I18N.md).

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_NAMES, DIFFICULTY_COLORS, MIN_SEATS, MAX_SEATS, MAX_SPECTATORS } from '../../../shared/constants.js';
// 座位数走命名空间：10 座包会在加载时改常量，直接具名导入会拿到旧值
import * as SEAT_CONST from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyIcon, Tooltip, Spinner, confirmDialog, doctorNo, Modal,
  TextField,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { TestMark } from '../ui/testConsole.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { LoadoutButton } from './loadout.js';
import { PluginTag, VersionTag, isModdedRoom } from '../ui/pluginTag.js';
import { VersionVote, versionVoteOf } from '../ui/versionVote.js';
import { VersionPicker } from '../ui/versionPicker.js';
import { DEFAULT_VERSION, lobbyVersion, needsContent, offeredDifficulties, roomVersion, serverDefaultVersion, soloTimedOf, soloTimeMsgid, versionLabel } from '../versions.js';
import { hasScriptConsent, rememberScriptConsent, pageVersion } from '../content.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating, savePref } from '../store.js';
import { data, useData, getConfig } from '../data.js';
import { chessAvatarUrl, chessPortraitUrl } from '../ui/assetUrls.js';
import { CARD_KEY, cardStore, setCard, cardOperators, cardContext, seatOperator, seatCardSkin, seatArtSrc } from '../ui/seatArt.js';
import { skinsStore, SKINS_KEY, ownerSkin } from '../ui/skins.js';
import { settingsStore } from '../ui/settingsStore.js';
import { difficultyInfo, ProtocolSelect, serverSeatMaxOf, LAYER_TEXT } from './lobby.js';
import { SupportButton } from './support.js';
import { ChatPanel } from './chat.js';
import * as roomMods from '../roomMods.js';
import { roomModsOf, shortDigest } from '../roomMods.js';
import { loadCatalog, planAlignment, alignRoom, missingPackIds, storeFor } from '../mods/align.js';
import { useRise } from '../ui/transitions.js';
import { t, tc } from '../../../shared/i18n.js';

/**
 * Seats padded to the room's capacity (co-op 4, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
const MAX_RENDERED_SEATS = 256;
const DEFAULT_SEATS = Number(SEAT_CONST.DEFAULT_SEATS) || MAX_SEATS;

export function normalizeSeats(room) {
  const declared = room?.seatCap;
  const cap = room?.mode === 'solo' ? 1
    : (Number.isInteger(declared) && declared >= 1 ? Math.min(declared, MAX_RENDERED_SEATS) : MAX_SEATS);
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  // a room with gameplay plugins (DESIGN §32.6) or another official version (§37.23): every player's page has loaded and
  // checked its content (the host's too); `modded` (非官方) is the plugins' alone
  const modded = isModdedRoom(room);
  const loadsContent = needsContent(room);
  const contentReady = !loadsContent || humans.every((s) => s.content === 'ready');
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine && contentReady && (!room?.content?.trusted || humans.every(s => room.content.trusted.consent[s.seat])),
    othersReady,
    modded,
    needsContent: loadsContent,
    // another official version (its seat tags and texts; a gameplay plugin room keeps the plugins' words)
    versionRoom: loadsContent && !modded,
    contentReady,
    myContent: loadsContent ? (mine?.content || 'loading') : 'ready',
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
  };
}

/**
 * The co-op room option 「AI 队友最后选择」 (GitHub #338; room.setAiPicksLast, room.state.aiPicksLast): in the strategy and
 * 机变 drafts every human picks before the AI teammates. null in a solo room (no AI teammates); otherwise its state (off
 * when the server sends none) and whether this player may switch it — the host only, the others see it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function aiLastOption(room, myId) {
  if (!room || room.mode === 'solo') return null;
  return { on: room.aiPicksLast === true, editable: room.hostId != null && room.hostId === myId };
}

/** Spectator handover is available only in original default-version co-op rooms, with a host opt-in. */
export function aiTakeoverOption(room, myId) {
  if (!room || room.mode === 'solo' || roomVersion(room) !== DEFAULT_VERSION || room.content?.vanilla === false) return null;
  return { on: room.aiTakeoverEnabled === true, editable: room.hostId != null && room.hostId === myId && !room.inMatch };
}

/**
 * The solo room option 「不限时」 (DESIGN §37.23.10; room.setSoloUnlimited). null unless the room is solo AND `timed`
 * is exactly true (a version whose solo is timed, and whose data is on screen). Off when room.state omits the key.
 * The host switches it; everybody else sees it read-only.
 * @param {any} room room.state payload
 * @param {any} myId
 * @param {boolean | null} timed soloTimedOf(config, room version)
 * @returns {{ on: boolean, editable: boolean } | null}
 */
export function soloUnlimitedOption(room, myId, timed) {
  if (!room || room.mode !== 'solo' || timed !== true) return null;
  return { on: room.soloUnlimited === true, editable: room.hostId != null && room.hostId === myId };
}

/**
 * An AI teammate's name split into its 「AI·」 prefix and the rest, for the plate (room.css hides the prefix on a phone:
 * the avatar's badge and the card's AI 队友 tag say it, and at 特大 the prefix left one character of the name,
 * 「AI·华…」). Null for a human seat and for a name that is only a number after the prefix (`AI·2`).
 * @param {{ isBot?: boolean, name?: string } | null | undefined} seat
 * @returns {[string, string] | null}
 */
export function botNameParts(seat) {
  const m = seat?.isBot ? /^(AI\s*·\s*)(\D.*)$/su.exec(seat.name || '') : null;
  return m ? [m[1], m[2]] : null;
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

/** A picker tile's avatar; the name's first character when the art pack has none or it fails to load. */
function CardThumb({ src, name }) {
  const [bad, setBad] = useState(false);
  return html`<span class="cardpick__img">${src && !bad
    ? html`<img src=${src} alt="" loading="lazy" draggable=${false} onError=${() => setBad(true)} />`
    : html`<span class="cardpick__glyph">${[...(name || '?')][0]}</span>`}</span>`;
}

/**
 * 名片干员 picker (更换立绘 on one's own seat card): the operators a seat card can show (ui/seatArt.js cardOperators —
 * search by name, rarity tabs) and 默认, no pick: the card shows the operator chosen by the player id. Picking closes it;
 * the current choice takes the focus (no on-screen keyboard on a phone). A local picker: each tile wears this browser's
 * outfit for that operator (`localSkins`, docs/SKINS.md), as the card will.
 */
function CardPicker({ current, list, m, localSkins = {}, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [star, setStar] = useState(0);
  const stars = useMemo(() => [...new Set(list.map((c) => c.rarity).filter((r) => r > 0))].sort((a, b) => b - a), [list]);
  const known = !!current && list.some((c) => c.charId === current);
  const needle = q.trim().toLowerCase();
  const shown = list.filter((c) => (!star || c.rarity === star)
    && (!needle || [c.name, c.appellation].some((v) => String(v || '').toLowerCase().includes(needle))));
  return html`<${Modal} open=${true} class="cardpick" micro="SEAT CARD OPERATOR" title=${t('名片干员')} width="min(10.4rem, 96vw)"
      onClose=${onClose} actions=${html`<${Button} variant="ghost" onClick=${onClose}>${t('关闭')}<//>`}>
    <div class="cardpick__bar">
      <${TextField} class="cardpick__search" size="sm" icon="search" value=${q} onInput=${setQ} placeholder=${t('搜索干员')} />
      <div class="cardpick__stars" role="radiogroup" aria-label=${t('稀有度')}>
        ${[0, ...stars].map((v) => html`<button key=${v} type="button" role="radio" aria-checked=${star === v ? 'true' : 'false'}
          class=${star === v ? 'is-on' : ''} onClick=${() => setStar(v)}>${v ? html`<span class="num">${v}★</span>` : t('全部')}</button>`)}
      </div>
    </div>
    <div class="cardpick__grid" data-testid="card-picker">
      <button type="button" class=${`cardpick__op cardpick__op--auto${known ? '' : ' is-on'}`} aria-pressed=${known ? 'false' : 'true'}
          data-char="" data-autofocus=${known ? undefined : ''} title=${t('按博士编号自动分配')} onClick=${() => onPick('')}>
        <span class="cardpick__img"><${Icon} name="refresh" /></span><span class="cardpick__name">${t('默认')}</span>
      </button>
      ${shown.map((c) => {
        const src = chessAvatarUrl(m, c, { skin: ownerSkin(c.charId, { localSkins }) });
        const on = known && c.charId === current;
        return html`<button key=${c.charId} type="button" class=${`cardpick__op r${c.rarity}${on ? ' is-on' : ''}`} aria-pressed=${on ? 'true' : 'false'}
            data-char=${c.charId} data-autofocus=${on ? '' : undefined} title=${c.name} onClick=${() => onPick(c.charId)}>
          <${CardThumb} src=${src} name=${c.name} />
          <span class="cardpick__name">${c.name}</span>${c.rarity ? html`<span class="cardpick__star num">${c.rarity}★</span>` : null}
        </button>`;
      })}
    </div>
    ${shown.length ? null : html`<p class="cardpick__empty">${t('没有符合条件的干员')}</p>`}
    <p class="cardpick__note"><${Icon} name="info" />${t('选择后，同盟里的博士都会看到这张立绘')}</p>
  <//>`;
}

/**
 * One seat: a tall card — the top strip (P#), the 名片干员 portrait (or the avatar frame: a bot, no art pack), 创建者, the
 * state at the bottom (准备中 / 待命中 / 已就绪 with its box) — and the name plate under it. The art's text sits in two
 * groups in flow, `.rseat__top` (the badge, 更换立绘, the tags) and `.rseat__low` (the operator's name, the state), so a
 * larger 文字大小 wraps and pushes them apart rather than drawing one over another (§37.18 review). One's own card offers 更换立绘
 * (`onPickCard`); the host gets 移出 / 移除 AI 队友 at the top right. An empty seat: 邀请 (copies the key) and, for the
 * host of a co-op room, 添加 AI 队友. `portrait` is the outfit's picture, `portraitDefault` the operator's default one
 * (given when an outfit is worn): a picture that fails to load gives way to the next, the last to the avatar frame.
 */
function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick, onInvite, portrait = null, portraitDefault = null, operator = null, onPickCard = null, fresh = false }) {
  const [badArt, setBadArt] = useState([]);
  const coop = room.mode !== 'solo';
  // the 转场 flash: a seat that turns ready (or becomes the host's), and an AI teammate added while the room is open
  // (`fresh`: this card mounted after the room was already on screen)
  const flash = useRise(!!seat && (seat.ready || seat.isBot || seat.playerId === room.hostId), 700, fresh);
  if (!seat) {
    const canAdd = coop && facts.isHost;
    const invitable = coop && !facts.spectating;
    return html`<article class="seat seat--empty rseat rseat--empty" style=${`--i:${index}`}>
      <span class="rseat__clip" aria-hidden="true"></span>
      <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
      <div class="rseat__art">
        ${invitable
          ? html`<button type="button" class="rseat__invite" onClick=${onInvite} title=${t('复制同盟密钥以邀请队友')}>
              <span class="rseat__plus" aria-hidden="true"></span><b>${t('邀请')}</b><small>${t('复制同盟密钥以邀请队友')}</small></button>`
          : html`<span class="rseat__wait"><small>${t('等待博士加入')}</small></span>`}
        ${canAdd ? html`<${Button} variant="secondary" size="sm" icon="robot" class="rseat__add" loading=${busy === 'add'} onClick=${onAddBot}>${t('添加 AI 队友')}<//>` : null}
        <span class="rseat__noinfo" aria-hidden="true">NOINFO</span>
      </div>
      <div class="rseat__plate rseat__plate--empty"><span class="seat__state t-dim">${t('空位')}</span></div>
    </article>`;
  }
  const consent = room.content?.trusted?.consent?.[seat.seat];
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  const lit = state === 'ready' || state === 'host';
  const art = seat.isBot ? null : seatArtSrc([portrait, portraitDefault], badArt);
  const canPick = isMe && !seat.isBot && !!onPickCard;
  // an AI teammate's name without its 「AI·」 prefix on a phone (room.css; botNameParts)
  const botPrefix = botNameParts(seat);
  return html`<article class=${`seat rseat${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''}${art ? ' has-art' : ''}${lit ? ' is-lit' : ''}${flash ? ' is-flash' : ''} is-${state}`}
      style=${`--i:${index}`}>
    <span class="rseat__clip" aria-hidden="true"></span>
    <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
    <div class="seat__art rseat__art">
      ${art
        ? html`<img key=${art} class="seat__portrait" src=${art} alt="" draggable=${false} onError=${() => setBadArt((b) => (b.includes(art) ? b : [...b, art]))} />`
        : html`<${AvatarFrame} size="xl" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />`}
      <div class="rseat__top">
        ${isHostSeat ? html`<span class="rseat__host"><${Icon} name="crown" />${t('创建者')}</span>` : null}
        ${seat.isBot ? html`<span class="rseat__bot"><${Icon} name="robot" />${t('AI 队友')}</span>` : null}
        ${canPick ? html`<button type="button" class="rseat__pick" data-testid="seat-card-pick" onClick=${onPickCard}
          title=${t('更换名片干员')} aria-label=${t('更换名片干员')}><${Icon} name="edit" /><span>${t('更换立绘')}</span></button>` : null}
        ${consent ? html`<span class="rseat__tag" data-testid="script-consented">${t('已同意')}</span>` : null}
        ${facts.needsContent && !seat.isBot ? html`<span class=${`rseat__tag seat__content is-${seat.content || 'loading'}`} data-testid="seat-content">
          ${facts.versionRoom
            ? seat.content === 'ready' ? t('版本数据就绪') : seat.content === 'failed' ? t('版本数据校验失败') : t('版本数据载入中')
            : seat.content === 'ready' ? t('插件内容就绪') : seat.content === 'failed' ? t('插件内容校验失败') : t('插件内容载入中')}
        </span>` : null}
      </div>
      ${offline ? html`<span class="rseat__lost"><${Icon} name="wifiOff" />${t('连接中断')}</span>` : null}
      <div class="rseat__low">
        ${art ? html`<span class="seat__op">${operator?.name || ''}</span>` : null}
        <span class=${`rseat__state seat__state--${state}`}>
          <span class="rseat__box">${lit ? html`<${Icon} name="check" />` : null}</span>
          <span class="rseat__said">${state === 'ready' ? t('已就绪') : state === 'host' ? t('待命中') : state === 'offline' ? t('连接中断') : t('准备中')}</span>
        </span>
      </div>
    </div>
    ${seat.isBot && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)}
      title=${t('移除该 AI 队友')} aria-label=${t('移除 AI 队友')}><${Icon} name="robot" /><${Icon} name="close" /></button>` : null}
    ${!seat.isBot && !isMe && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `kick${index}`}
      onClick=${() => onKick(index, seat.name, seat.playerId)} title=${t('将该博士移出同盟')} aria-label=${t('移出该博士')}><${Icon} name="user" /><${Icon} name="close" /></button>` : null}
    <div class="rseat__plate">
      ${isMe ? html`<span class="rseat__me" role="img" aria-label=${t('你')} title=${t('你')}><${Icon} name="info" /></span>` : null}
      <${AvatarFrame} size="sm" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} />
      <span class="rseat__who"><b class="seat__name">${botPrefix ? html`<span class="seat__name-pre">${botPrefix[0]}</span>${botPrefix[1]}` : seat.name || t('博士')}</b>${isMe ? html`<span class="seat__you" aria-hidden="true">${t('你')}</span>` : null}</span>
      <small class="rseat__doc">${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}</small>
    </div>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label=${t('观战席')}>
    <span class="specbar__label"><${Icon} name="eye" />${t('观战席')}<b class="num">${facts.spectators.length}</b><span class="num t-dim">/${MAX_SPECTATORS}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}${s.name || t('博士')}${s.playerId === myId ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${t('移出观战者 {name}', { name: s.name || '' })} title=${t('移出该观战者')} />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>${t('入座')}<//>` : null}
  </section>`;
}

/** The 「不限时」 switch (a timed solo): the host toggles it, everybody else sees its state. */
function SoloUnlimitedToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-solo-unlimited"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('不限时')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/** The 「AI 队友最后选择」 switch (co-op): the host toggles it, everybody else sees its state. */
function AiLastToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('策略与机变轮选时，所有博士先于 AI 队友选择')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'}
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('AI 队友最后选择')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

function AiTakeoverToggle({ option, busy, onToggle }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('默认关闭。开启后，观战者可在休整期经同房间真人投票接替 AI；继承记录不计个人统计或奖励。')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'} data-testid="room-ai-takeover"
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${!option.editable || !!busy}
          onClick=${() => option.editable && onToggle(!option.on)}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('允许观战者接替 AI')}
      </button>
    <//>
    ${option.editable ? null : html`<span class="t-dim">${t('由创建者设置')}</span>`}
  </div>`;
}

/**
 * ⚙ of the bottom pill (co-op): 同盟设置 — the 模拟难度 (opens 选择模拟协议: the host's 确认, the others' read-only view)
 * and the 「AI 队友最后选择」 switch. Closes on a click outside it or Esc.
 */
function RoomOptions({ option, takeoverOption, onAiTakeover, soloOption = null, room, isHost, busy, onAiLast, onSoloUnlimited, onDifficulty, onClose, version = null, onSeatCap = null }) {
  const host = isHost;
  const info = difficultyInfo(room.mode, room.difficulty);
  const title = soloOption ? t('模拟设置') : t('同盟设置');
  useEffect(() => {
    const away = (e) => { if (!e.target.closest?.('.rs-opts, .rs-pill__gear')) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('pointerdown', away);
    addEventListener('keydown', onKey);
    return () => { removeEventListener('pointerdown', away); removeEventListener('keydown', onKey); };
  }, []);
  return html`<div class="rs-opts" role="dialog" aria-label=${title}>
    <h4>${title}</h4>
    ${room.mode === 'coop' && host && onSeatCap
      ? html`<div class="rs-opts__row" data-testid="room-opt-seatcap">
        <${SeatCapSetter} room=${room} isHost=${host} onPick=${onSeatCap} />
      </div>`
      : null}
    ${soloOption ? null : html`<div class="rs-opts__row" data-testid="room-opt-difficulty">
      <span class="rs-opts__k">${t('模拟难度')}</span>
      <button type="button" class="rs-opts__diff" disabled=${isHost && !!busy} onClick=${onDifficulty}
          title=${isHost ? t('更改模拟难度') : t('由创建者选择')}>
        <${DifficultyIcon} difficulty=${room.difficulty} />${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num rs-pill__code">${info.code}</span>
        ${isHost ? html`<em>${t('更改')}</em>` : null}
      </button>
      ${isHost ? null : html`<span class="t-dim">${t('由创建者选择')}</span>`}
    </div>`}
    ${!soloOption && version ? html`<div class="rs-opts__row" data-testid="room-opt-version">
      <span class="rs-opts__k">${t('版本')}</span>
      <${Tooltip} text=${version.why}>
        <button type="button" class="rs-opts__diff rs-opts__ver" disabled=${version.disabled} onClick=${version.onOpen}
            title=${version.editable ? t('发起切换版本') : t('由创建者发起')}>
          <${Icon} name="book" />${versionLabel(version.id)}${version.editable ? html`<em>${t('切换')}</em>` : null}
        </button>
      <//>
      ${version.editable ? null : html`<span class="t-dim">${t('由创建者发起')}</span>`}
    </div>` : null}
    <${AiTakeoverToggle} option=${takeoverOption} busy=${busy} onToggle=${onAiTakeover} />
    ${soloOption
      ? html`<${SoloUnlimitedToggle} option=${soloOption} busy=${busy} onToggle=${onSoloUnlimited} />`
      : html`<${AiLastToggle} option=${option} busy=${busy} onToggle=${onAiLast} />`}
  </div>`;
}

/** A gear (the pill's ⚙, in the place of the event's 快速搜寻: matchmaking is dropped — the maintainer's PR #643 keep / drop list, 2026-10-15). */
function GearGlyph() {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" /></svg>`;
}

/**
 * The big button of the bottom right (开始模拟 / 准备就绪 / 已就绪 / 观战中), styled like 选择模拟协议's. A disabled reason goes in
 * the project's Tooltip around it (review of PR #813: a native title never shows on touch).
 */
function GoButton({ label, onClick, disabled, loading = false, ready = null, icon = null }) {
  return html`<button type="button" class=${`proto-start rs-go${ready ? ' is-ready' : ''}`} disabled=${disabled} onClick=${onClick}
      aria-busy=${loading ? 'true' : 'false'}>
    ${ready != null
      ? html`<span class="rs-go__box" aria-hidden="true">${ready ? html`<${Icon} name="check" />` : null}</span>`
      : icon
        // (a spectator's 观战中: its eye in the mark's place, so the label keeps the width — §37.18 review)
        ? html`<span class="rs-go__icon" aria-hidden="true"><${Icon} name=${icon} /></span>`
        : html`<span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>`}
    <span class="proto-start__label">${loading ? html`<${Spinner} size="sm" />` : null}${label}</span>
    <span class="proto-start__deco" aria-hidden="true"></span>
  </button>`;
}

/** How long a version proposal refused as too frequent (RATE) waits before it is sent once more [ASSUMED]. */
const PROPOSE_RETRY_MS = 1200;

/** Room screen component. */

// ---------------------------------------------------------------------------------------------------
// 本 fork 的房间屏部件：座位上限（业主裁决 B5）、模组面板（docs/WORKSHOP.md §1.9.3）、对齐闸门。
// 上游 0.3.2 重写了这一屏，但这些部件只在本 fork 里，合并时原文搬回来。
// ---------------------------------------------------------------------------------------------------

/**
 * 本房座位上限 (业主裁决 B5, docs/META.md §1.9) — the host's slider range for the room it is ALREADY in.
 *
 * `null` means "there is nothing to choose here, do not draw a slider at all": a solo room (its one-seat shape has no
 * cap to pick) and a room whose occupants already fill every legal seat (a slider with one stop is a dead control).
 *
 * The bounds are the SERVER's rules, mirrored so the host cannot drag into a refusal:
 *   * `max` = this server's ceiling (`welcome.maxSeats`, read through `serverSeatMaxOf`; `MAX_SEATS` 4 when the
 *     deployment said nothing), never below the room's current cap — a slider that cannot even show the current value
 *     would be lying about the room.
 *   * `min` = `max(MIN_SEATS, highest occupied seat + 1)`. That is exactly the server's eviction guard
 *     (`Lobby.setSeatCap` refuses `cap <= highest`), expressed on the frame the client actually holds, so every stop
 *     the host can reach is one the server accepts. It counts the HIGHEST OCCUPIED SEAT rather than the number of
 *     people, because seats may have holes (the creator leaving for good empties seat 0 while seat 2 stays taken) and
 *     a count would let the slider offer a cap that drops somebody at index 2.
 *
 * @param {any} room room.state payload
 * @param {number} serverMax the ceiling `welcome.maxSeats` announced (absent / unusable ⇒ MAX_SEATS)
 * @returns {{ min: number, max: number, value: number } | null}
 */
export function seatCapRoomRange(room, serverMax) {
  if (!room || room.mode === 'solo') return null;
  const seats = normalizeSeats(room);
  const cap = seats.length;
  const ceiling = Number.isInteger(serverMax) && serverMax >= 1 ? serverMax : MAX_SEATS;
  const max = Math.max(ceiling, cap);
  const highest = seats.reduce((m, s, i) => (s ? i : m), -1);
  const min = Math.min(Math.max(MIN_SEATS, highest + 1), max);
  if (max <= min) return null;
  return { min, max, value: Math.min(Math.max(cap, min), max) };
}

/**
 * The host's seat-count control INSIDE the room (`room.setSeatCap`, 业主裁决 B5). Rendered for the host only: for
 * everybody else the room already says how many seats it has through its seat cards, and `room.state.seatCap` is what
 * pads them (`normalizeSeats`).
 *
 * The server answers a refusal with a NAMED code (`SEAT_CAP_TOO_SMALL` when the new cap cannot hold the people already
 * here, `BAD_MSG` when the number itself is not a legal seat count), and `run` toasts it — the slider never silently
 * becomes a different number than the host asked for. `asked` keeps that request on screen until the room's own frame
 * agrees (or the request fails), so a slow round trip does not snap the control back under the host's finger.
 * @param {{ room: any, isHost: boolean, onPick: (n: number) => Promise<boolean> }} props
 */
function SeatCapSetter({ room, isHost, onPick }) {
  const range = isHost ? seatCapRoomRange(room, serverSeatMaxOf()) : null;
  const [asked, setAsked] = useState(null);
  useEffect(() => {
    if (asked != null && room && room.seatCap === asked) setAsked(null);
  }, [asked, room]);
  if (!range) return null;
  const shown = asked != null && asked >= range.min && asked <= range.max ? asked : range.value;
  const pct = Math.round(((shown - range.min) / (range.max - range.min)) * 100);
  const commit = async (v) => {
    const want = Math.min(Math.max(v, range.min), range.max);
    if (want === range.value) { setAsked(null); return; }
    setAsked(want);
    if (!(await onPick(want))) setAsked(null);   // the frame (or the refusal) is the truth again
  };
  return html`<div class="seat-cap seat-cap--room">
    <${MicroLabel} tone="mint">SEATS<//>
    <span class="seat-cap__name">${t('本房间人数上限')}</span>
    <input class="seat-cap__slider" type="range" min=${range.min} max=${range.max} step="1" value=${shown}
      style=${`--pct:${pct}%`} aria-label=${t('本房间人数上限')}
      aria-valuemin=${range.min} aria-valuemax=${range.max} aria-valuenow=${shown}
      title=${t('不能小于同盟内现有人数（含 AI 队友）')}
      onInput=${(e) => setAsked(Number(e.currentTarget.value))}
      onChange=${(e) => commit(Number(e.currentTarget.value))} />
    <span class="seat-cap__value num">${shown}<span class="t-dim"> / ${range.max}</span></span>
  </div>`;
}

/**
 * 房主**现在**能不能在房间里改本房间的模组集合（G1/G2 的客户端镜像）。
 *
 * 它是服务端 `room.mods` 那两条守卫（`server/lobby.js setRoomMods` / `roomModsRefusal`）的**同一份判据的读法**，
 * 只用来决定「那个入口给不给」——真正说了算的永远是服务端（客户端能画错，但改不动）。写成纯函数是为了能被真跑：
 * `test/client-static.test.js` 的 screen helpers 直接喂 `room.state` 形状给它。
 *
 * 三条，与服务端逐条对应：
 *   * 只有房主（`NOT_HOST`）；
 *   * 对局没开始（`MOD_SET_LOCKED`）；
 *   * **没有任何真人座位已就绪**（`MOD_SET_LOCKED`）—— AI 座位不算：`addBot` 建出来的座位天生 `ready: true`，
 *     而 AI 从不对齐任何字节（照字面收进来，房主一加 AI 队友就再也改不了集合）。
 * @param {any} room `room.state` 形状的房间（可为 null）
 * @param {string|null} myId
 * @returns {boolean}
 */
export function canEditRoomMods(room, myId) {
  if (!room || room.inMatch) return false;
  const facts = roomFacts(room, myId);
  if (!facts.isHost) return false;
  return !facts.seats.some((s) => s && !s.isBot && s.ready === true);
}

/**
 * **对齐硬门**的那一条判据（W-D）：本机现在算不算「按这个房间声明的集合对齐好了」。
 *
 * 三种状态都算挡住：
 *   * `checking` —— 摘要刚变、`planAlignment` 还没出结论（上一份摘要的 `ok: true` **不是关于这一份集合的结论**）；
 *   * `needed && !ok` —— 核过了，缺件（或房间点名了本服务器没有的包）；
 *   * 其它（`null` = 这个房间没声明集合、或 `ok: true`）⇒ 放行。
 *
 * **只有一份实现**：非房主的「准备就绪」与（⑥ 起）solo 房主的「开始模拟」都读它 —— 两份写法就是两个会漂的真相，
 * 而漂的方向是「一边放行、另一边挡住」。
 * @param {{ ok: boolean, needed: boolean, missing: number, checking?: boolean }|null} align
 * @returns {boolean}
 */
export function isAlignBlocked(align) {
  return !!(align && (align.checking || (align.needed && !align.ok)));
}

/**
 * 房主的**开始模拟**要不要被对齐挡住（⑥）。**只作用于 solo**。
 *
 * co-op 房主的开始**不看**自己本机的对齐 —— 这是 W-D 定的口径，改它等于换一条开局政策：另几位博士各自被自己的
 * 「准备就绪」挡着，而他们的就绪本来就是房主开局的依据。
 *
 * solo 房不一样：`server/lobby.js start` 对 solo 要求**恰好一个真人、零 AI** ⇒ 场上没有第二个人的「准备就绪」
 * 能替他挡；而 G3 之后 solo 房**也能声明集合**了 ⇒ 「本机缺件」与「点得动开始」同时成立，开局之后也没有任何人
 * 能拦。所以这一格补上：缺件（或还在核对）时开始按钮被挡住，补齐即可开。
 * @param {{ solo?: boolean, align: { ok: boolean, needed: boolean, missing: number, checking?: boolean }|null }} o
 * @returns {boolean}
 */
export function hostStartAlignBlocked({ solo, align }) {
  return solo === true && isAlignBlocked(align);
}

/**
 * 本房间使用 mod (W-A/W-D, DESIGN §28.16): the set THIS room declared, shown to every member and spectator from
 * `room.state.mods`, ALONG WITH whether this client really holds it. Absent when the room declared none, in which case
 * this component returns nothing — a room on a plain install (or one whose host ticked nothing) looks exactly as it did
 * before this feature.
 *
 * W-D is the second half: the panel asks `planAlignment` (public/js/mods/align.js) whether the bytes on THIS client
 * rebuild every pack the room declared, offers to download exactly those (`alignRoom`), draws the progress `sync`
 * reports, and tells the room screen whether the Ready button may be offered at all. A server that carries packs this
 * client cannot name is called out by name instead of silently staying 「未就绪」.
 * @param {{ room: any, onAlignment?: (state: { ok: boolean, needed: boolean, missing: number }|null) => void }} props
 */
function RoomModsPanel({ room, myId = null, onAlignment = null }) {
  const mods = roomModsOf(room);
  // 服务端声明过哪些包（`welcome.mods.packs`，main.js 写进 store.roomMods）：房主在房间里能挑的就是这一份的子集。
  const available = roomMods.availableMods();
  const editable = available.length > 0 && canEditRoomMods(room, myId);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState([]);
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const report = onAlignment || (() => {});
  const digest = mods ? mods.digest : null;

  // Ask once per room set: the answer decides both what this panel shows and whether Ready is offered. A room without a
  // declaration reports 「无需对齐」 and the panel disappears.
  useEffect(() => {
    if (!digest) { setPlan(null); setChecked(true); report(null); return undefined; }
    let live = true;
    setChecked(false);
    // **摘要一变就先把准备就绪锁住**（G2 的客户端那一半）：集合变了，加入者可能缺文件 —— 而 `planAlignment`
    // 要读盘、要哈希，是异步的。在它出结论之前，上一份摘要的 `ok: true` **不是关于这一份集合的结论**，照旧拿它
    // 放行就是「改了集合、有人拿着旧结论点了准备就绪」。所以先报一个 `checking`，硬门据此拒点，等真实结论回来再放行。
    report({ ok: false, needed: true, missing: 0, checking: true });
    (async () => {
      const catalog = await loadCatalog();
      const next = await planAlignment({ catalog, mods, store: storeFor() });
      if (!live || !alive.current) return;
      setPlan(next);
      setChecked(true);
      report({ ok: next.ok, needed: next.needed, missing: next.missingFiles });
    })().catch(() => { if (live) { setChecked(true); setPlan(null); report(null); } });
    return () => { live = false; };
    // `digest` is the identity of the set: the same packs re-announced must not re-download or re-hash
  }, [digest]);

  // 干净安装（服务器没声明任何包）⇒ 一个字节都不多；没声明集合**且改不了** ⇒ 与从前逐字节相同。
  if (!mods && !editable) return null;
  const known = plan ? plan.packs : null;
  const unknown = plan ? plan.unknown : [];
  const missingFiles = plan ? plan.missingFiles : 0;
  const ready = !!plan && plan.ok;

  /**
   * 打开/收起房主改集合的面板：勾选状态**每次打开都从房间的现状重建**（`room.mods`），不是从上次残留的勾选 ——
   * 一个停在那里、与房间真实集合不一致的界面，比没有界面更难查。
   */
  const openEdit = () => { setPicked(mods ? mods.packs.map((p) => p.id) : []); setEditing(true); };
  const togglePick = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].sort()));

  /**
   * 提交 `room.mods { modIds }`（G1 的客户端发送点）。
   *
   * 成功之后**这里什么都不用做**：服务端把新的 `room.state` 广播给全房 ⇒ `room.mods.digest` 变了 ⇒ 上面那个
   * `useEffect` 的依赖 `[digest]` 立刻重跑 `planAlignment`，先把准备就绪锁住、拿到真实结论再放行。客户端**不本地
   * 改房间状态** —— 房主的乐观更新会让「我以为改了」与「服务端其实拒了」在一瞬间长得一样。
   */
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await net.request('room.mods', { modIds: picked });
      if (alive.current) setEditing(false);
      toast(t('本房间的模组集合已提交'), 'success');
    } catch (err) {
      toastError(err);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const fill = async () => {
    if (busy) return;
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      const catalog = await loadCatalog();
      const next = await alignRoom({
        catalog, mods, store: storeFor(),
        onProgress: (e) => { if (alive.current && (e.type === 'done' || e.type === 'file-start' || e.type === 'file-done' || e.type === 'file-skipped')) setProgress({ done: e.done ?? 0, total: e.total ?? 0 }); },
      });
      if (!alive.current) return;
      setPlan(next);
      report({ ok: next.ok, needed: next.needed, missing: next.missingFiles });
      if (!next.ok) toast(t('模组仍未就绪：{ids}', { ids: missingPackIds(next).join(', ') || '—' }), 'warn');
    } catch (err) {
      if (alive.current) toastError(err);
    } finally {
      if (alive.current) { setBusy(false); setProgress(null); }
    }
  };

  return html`<div class="room-mods brackets">
    <${MicroLabel} tone="mint">ROOM MODS<//>
    ${mods ? html`<span class="room-mods__title">${t('本房间使用模组（{n} 个）', { n: mods.packs.length })}</span>
      <span class="room-mods__digest num" title=${mods.digest}>${shortDigest(mods.digest)}…</span>` : null}
    ${ready ? html`<span class="room-mods__state t-mint">${t('本机已就绪')}</span>` : null}
    ${mods ? html`<ul class="room-mods__list">
      ${mods.packs.map((p) => {
        const state = known ? known.find((x) => x.id === p.id) : null;
        return html`<li key=${p.id}>
          <span class="room-mods__id">${p.id}</span>
          <span class="room-mods__meta">${t(LAYER_TEXT[p.layer] || p.layer)}${p.combat ? ` · ${t('会改动战斗结果')}` : ''}</span>
          ${state && !state.ok ? html`<span class="room-mods__state t-orange">${state.known ? t('本机缺件') : t('本服务器没有这个包')}</span>` : null}
        </li>`;
      })}
    </ul>` : html`<span class="room-mods__none t-lo">${t('本房间没有声明模组（模拟按服务器加载的全部模组运行）')}</span>`}
    ${checked && plan && !plan.ok
      ? html`<div class="room-mods__fill">
          <span class="t-lo">${unknown.length ? t('房间点名了本服务器没有的模组：{ids}', { ids: unknown.join(', ') }) : t('本机还缺 {n} 个模组文件', { n: missingFiles })}</span>
          <${Button} variant="secondary" size="sm" icon="refresh" loading=${busy} disabled=${busy || unknown.length > 0} onClick=${fill}>
            ${busy && progress && progress.total ? t('正在补齐 {done}/{total}', { done: progress.done, total: progress.total }) : t('补齐模组')}<//>
        </div>`
      : null}
    ${editable
      ? html`<div class="room-mods__edit">
          ${editing
            ? html`<div class="room-mods__pick">
                <span class="t-lo">${t('勾选本房间要声明的模组（不勾 = 不声明，模拟按服务器加载的全部模组运行）')}</span>
                <ul class="room-mods__list">
                  ${available.map((p) => html`<li key=${p.id}>
                    <button type="button" class=${`mod-chip${picked.includes(p.id) ? ' is-on' : ''}`}
                      aria-pressed=${picked.includes(p.id) ? 'true' : 'false'} onClick=${() => togglePick(p.id)}>
                      <span class="mod-chip__id">${p.id}</span>
                      <span class="mod-chip__meta">${t(LAYER_TEXT[p.layer] || p.layer)}${p.combat ? ` · ${t('会改动战斗结果')}` : ''}</span>
                    </button>
                  </li>`)}
                </ul>
                <div class="room-mods__apply">
                  <span class="t-lo">${t('集合变更后，本房其它博士需要重新对齐并再次准备就绪')}</span>
                  <${Button} variant="secondary" size="sm" loading=${saving} disabled=${saving} onClick=${save}>${t('应用更改')}<//>
                  <${Button} variant="ghost" size="sm" disabled=${saving} onClick=${() => setEditing(false)}>${t('取消更改')}<//>
                </div>
              </div>`
            : html`<${Button} variant="secondary" size="sm" icon="refresh" onClick=${openEdit}>${t('更改本房间模组')}<//>`}
        </div>`
      : null}
  </div>`;
}

export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
  // 名片干员: the operators a seat card can show and the default pool (ui/seatArt.js), one's own pick (a pref the sync
  // engine sends: ui/loadoutSync.js installCardSync), and the outfits the cards wear — this browser's choices and the
  // 「显示其他玩家的皮肤」 switch (docs/SKINS.md)
  useData('chess', 'assets', 'config');
  const chess = data.get('chess');
  const cardList = useMemo(() => cardOperators(data.list('chess')), [chess]);
  const cards = useMemo(() => cardContext(cardList), [cardList]);
  const myCard = useStore((s) => s[CARD_KEY], Object.is, cardStore);
  const localSkins = useStore((s) => s[SKINS_KEY], Object.is, skinsStore);
  const otherSkins = useStore((s) => s.otherSkins !== false, Object.is, settingsStore);
  const [picking, setPicking] = useState(false);
  // the room whose seats are on screen: a seat card that mounts after its first render is new (an AI teammate added)
  const shownRoom = useRef('');
  useEffect(() => { shownRoom.current = room?.code || ''; });
  // 选择模拟协议 over the room — open, and the host's pick before 确认 (the others read it: the room's difficulty) — and
  // the ⚙ menu
  const [protoOpen, setProtoOpen] = useState(false);
  const [protoPick, setProtoPick] = useState(null);
  const [opts, setOpts] = useState(false);
  // the host's change of difficulty, told to the others (see the header); never on entering a room or switching rooms
  const seenDiff = useRef(room ? `${room.code}|${room.difficulty}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${room.difficulty}`;
    const before = seenDiff.current;
    seenDiff.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`) || room.hostId === me.playerId) return;
    const name = DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : room.difficulty;
    toast(t('创建者已将模拟难度改为「{name}」', { name }), 'info');
  }, [room?.code, room?.difficulty]);
  // official versions (DESIGN §37.23): the room's switch is told to everybody (the host's own page included — a vote's
  // result arrives later than the pick); never on entering a room or switching rooms
  const versions = useStore((s) => s.versions);
  const myLobby = useStore(lobbyVersion);
  const serverDefault = useStore(serverDefaultVersion);
  const [versionOpen, setVersionOpen] = useState(false);
  const seenVersion = useRef(room ? `${room.code}|${roomVersion(room)}` : '');
  useEffect(() => {
    if (!room) return;
    const key = `${room.code}|${roomVersion(room)}`;
    const before = seenVersion.current;
    seenVersion.current = key;
    if (!before || before === key || !before.startsWith(`${room.code}|`)) return;
    setVersionOpen(false);
    toast(t('同盟已切换到「{version}」', { version: versionLabel(roomVersion(room)) }), 'success');
  }, [room?.code, room?.version]);
  // the room sees one's pick once the server has it (seats[].card): ui/loadoutSync.js installCardSync sends it after
  // every pick, welcome and content change and retries a RATE / TIMEOUT / OFFLINE refusal (review of PR #813)
  const pickCard = (charId) => { setCard(charId); setPicking(false); };

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const facts = roomFacts(room, me.playerId);
  // 对齐状态（W-D, DESIGN §28.16）：房间声明了集合而本机还没拿到那几个包时，solo 房主的「开始模拟」
  // 也要挡住 —— 服务端会在开局那一刻拒绝（CONTENT_NOT_READY / 缺件），别让玩家点一个注定失败的按钮。
  // `align` 由 RoomModsPanel 算完回填（它才是问 planAlignment 的那一处）。
  const [align, setAlign] = useState(null);
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);

  /** Runs one request at a time; resolves true once the server took it (false: not sent, or refused — toasted). */
  const run = async (kind, fn) => {
    if (inFlight.current) return false;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return false; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); return true; } catch (err) { toastError(err); return false; } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const alignBlocked = isAlignBlocked(align);
  const soloAlignBlocked = hostStartAlignBlocked({ solo: !coop, align });
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  // 本房座位上限 (业主裁决 B5)：`code` 一并送，陈旧帧上的动作只可能拿到 NOT_IN_ROOM，
  // 不会去改「它现在碰巧在的那个房间」。返回值给滑块用：失败时它退回房间自己的帧。
  const setSeatCap = (seatCap) => run('seatcap', () => net.request('room.setSeatCap', { code: room.code, seatCap }));
  const setAiTakeover = (on) => run('aihandover', () => net.request('room.setAiTakeover', { on }));
  const setAiLast = (on) => run('ailast', () => net.request('room.setAiPicksLast', { on }));
  // the room is the authority; the lobby card reads the same pref the next time this browser creates a solo room
  const setSoloUnlimited = async (on) => {
    const sent = await run('solofree', () => net.request('room.setSoloUnlimited', { on }));
    if (sent) savePref('lobby.soloUnlimited', on === true);
  };
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code, ...(room.test ? { testAck: true } : {}) }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: t('离开同盟'), text: t('你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${t('连接中断，正在重连…')}</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />${t('观战中 · 不占博士席位，模拟开始后可切换观看各位博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : facts.versionRoom && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入「{version}」的数据', { version: versionLabel(roomVersion(room)) })}</span>`
    : facts.needsContent && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入房间的插件内容')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待创建者开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，创建者即可开始模拟')}</span>`;

  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」 — with the
    // version's name for another official version (DESIGN §37.23)
    const params = { name: me.name ?? '', difficulty: DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : '' };
    const invite = roomVersion(room) !== DEFAULT_VERSION
      ? t('{name}邀请你加入卫戍协议：盟约·{version}【{difficulty}】', { ...params, version: versionLabel(roomVersion(room)) })
      : t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', params);
    const ok = await copyText(what === 'code' ? room.code : `${inviteLink(room.code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code: room.code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  // 选择模拟协议 over the room: the host picks and sends the difficulty on 确认 (nothing to send when it did not change —
  // unless a plugin mode is on, which picking a difficulty leaves: server/lobby.js setDifficulty); it closes only once the
  // server took it, and the accepted pick becomes the remembered difficulty (`lobby.difficulty`, the one 创建同盟 and
  // 独立模拟's 选择模拟协议 start from — README / PLAYING 难度沿用上次选的). Everybody else opens it read-only.
  const openProto = () => { setOpts(false); setProtoPick(room.difficulty); setProtoOpen(true); };
  const closeProto = () => { setProtoOpen(false); setProtoPick(null); };
  const pluginMode = room.content?.modeId ? (room.content.modes || []).find((m) => m.id === room.content.modeId)?.name || room.content.modeId : null;
  const confirmDifficulty = async () => {
    const d = protoPick || room.difficulty;
    if (d === room.difficulty && !pluginMode) { closeProto(); return; }
    if (!(await setDifficulty(d))) return;
    savePref('lobby.difficulty', d);
    // the plugin mode is gone: said, as a same-difficulty 确认 changes nothing else the host sees (§37.51; §37.18's nit)
    if (pluginMode) toast(t('已退出插件模式「{name}」', { name: pluginMode }), 'info');
    if (alive.current) closeProto();
  };
  // the difficulties the room's version offers (its config's modes, versions.js) — the page shows that version's data
  // once it is loaded; until then (or for a gameplay plugin room's own modes) all four
  const protoDifficulties = offeredDifficulties(pageVersion() === roomVersion(room) ? getConfig() : null, room.mode);
  const protoHint = pluginMode
    ? t('确认后将退出插件模式「{name}」', { name: pluginMode })
    : facts.humans.length > 1 ? t('更改难度后，其他博士需要重新准备就绪') : '';
  const aiLast = aiLastOption(room, me.playerId);
  const soloTimed = soloTimedOf(pageVersion() === roomVersion(room) ? getConfig() : null, roomVersion(room));
  const soloOpt = soloUnlimitedOption(room, me.playerId, soloTimed);
  const soloBrief = soloTimeMsgid('brief', { timed: soloTimed, unlimited: room.soloUnlimited === true });
  const modeName = coop ? t('同盟模拟') : t('独立模拟');
  // the room's version (DESIGN §37.23): the pill and ⚙'s row on a server that enables versions (or in a version room)
  const vote = versionVoteOf(room);
  const curVersion = roomVersion(room);
  const showVersion = Array.isArray(versions) || curVersion !== DEFAULT_VERSION;
  const versionWhy = !online ? t('连接中断，请稍候重试')
    : vote ? t('切换版本投票进行中，请等投票结束')
    : facts.modded ? t('请先关闭改变玩法的插件')
    : !Array.isArray(versions) || versions.length < 2 ? t('本服务器只启用了这一个版本') : null;
  const versionEditable = facts.isHost && !facts.spectating && !room.inMatch;
  // the room's version is not this browser's lobby choice: the banner says leaving restores it (on a short screen, where
  // the banner gives its room to the seats, the pill's tooltip says it)
  const bannerText = curVersion !== myLobby && Array.isArray(versions) ? t('本房间为「{room}」，离开后恢复你的大厅版本「{mine}」', { room: versionLabel(curVersion), mine: versionLabel(myLobby) }) : null;
  const versionCtl = showVersion ? {
    id: curVersion, editable: versionEditable, why: [versionEditable ? versionWhy : t('由创建者发起'), bannerText].filter(Boolean).join(' · ') || null,
    disabled: versionEditable ? !!versionWhy || !!busy : !Array.isArray(versions),
    onOpen: () => { setOpts(false); setVersionOpen(true); },
  } : null;
  // (a switch makes every page send its settings again, which share the server's budget of heavy messages with
  // room.proposeVersion: a RATE right after one is tried once more a moment later; the server's own 5 s pause after a
  // declined or expired vote answers RATE again and is told)
  const proposeVersion = async (version) => {
    const send = () => net.request('room.proposeVersion', { version });
    const sent = await run('version', async () => {
      try { await send(); } catch (err) {
        if (err?.code !== 'RATE') throw err;
        await new Promise((r) => setTimeout(r, PROPOSE_RETRY_MS));
        await send();
      }
    });
    if (sent && alive.current) setVersionOpen(false);
  };

  return html`<div class=${`screen room-screen rs${coop ? '' : ' rs--solo'}${facts.seats.length > DEFAULT_SEATS ? ' rs--big' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[room.difficulty] || 'var(--amber)'}; --n:${facts.seats.length}`}>
    <div class="rs__bg" aria-hidden="true"></div>
    <header class="topbar rs-top">
      <div class="topbar__left rs-top__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <button type="button" class="rs-exit" disabled=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')}><${Icon} name="exit" /></button>
        <//>
        <div class="rs-clock">
          <b>${modeName}${room.test ? html` <${TestMark} />` : null}<${VersionTag} room=${room} class="rs-clock__ver" />
            ${pluginMode ? html`<span class="rs-clock__sep"></span><span class="room-mode" data-testid="room-mode">${pluginMode}</span>` : null}</b>
          <span class="rs-clock__ping">${t('当前延迟')}<${PingPill} ms=${conn.ping} online=${online} /></span>
        </div>
        <div class="rs-tools">
          <${Button} variant="secondary" size="sm" square=${true} icon="chart" class="stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')} />
          <${SettingsButton} class="room-settings" variant="secondary" square=${true} />
          <${GuideButton} class="room-guide" variant="secondary" square=${true} />
        </div>
        <${PluginTag} room=${room} myId=${me.playerId} />
      </div>
      <div class="rs-top__right">
        <${LoadoutButton} from="room" size="md" class="hub-plate hub-plate--loadout rs-loadout room-loadout" label=${t('干员调配')} />
        ${coop ? html`<div class="rs-key">
          <span class="rs-key__k">${t('同盟密钥')}</span>
          <b class="rs-key__code num selectable" aria-label=${t('同盟密钥 {code}', { code: room.code })}>${room.code}</b>
          <button type="button" class="rs-key__copy" onClick=${() => copy('code')} title=${t('复制密钥')}>${t('复制')}</button>
          <button type="button" class="rs-key__link" onClick=${() => copy('link')} title=${t('复制链接')} aria-label=${t('复制链接')}><${Icon} name="link" /></button>
        </div>` : html`<div class="rs-key rs-key--solo"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class=${`seats rs-seats${coop ? '' : ' seats--solo'}`}>
      ${facts.seats.map((s, i) => {
        const op = seatOperator(s, cards, { myId: me.playerId, myCard });
        // the player's outfit for that operator (header "Outfits"); null = the default art
        const skin = op ? seatCardSkin(s, op.chess.charId, { myId: me.playerId, localSkins, players: facts.occupied, otherSkins }) : null;
        return html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
          myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} onInvite=${() => copy('code')}
          portrait=${op ? chessPortraitUrl(data.get('assets'), op.chess, { skin }) : null}
          portraitDefault=${op && skin ? chessPortraitUrl(data.get('assets'), op.chess) : null} operator=${op?.chess} onPickCard=${() => setPicking(true)}
          fresh=${shownRoom.current === room.code} />`;
      })}
      ${coop ? null : html`<aside class="solo-brief rs-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''} <span class="num t-dim">${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
          ${soloBrief ? html`<li>${t(soloBrief)}</li>` : null}
        </ul>
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />
    <${VersionVote} room=${room} />
    ${bannerText ? html`<p class="rs-verbanner" data-testid="version-banner"><${Icon} name="info" />${bannerText}</p>` : null}

    ${/* 房间屏的**旁栏**宿主（`screen.room.aside`，docs/WORKSHOP.md §1.9.3 的第 10 槽）：容器由**组件自己**渲染
         （`[data-mod-slot]`），**不在** `extensions.js MOD_PANEL_CREATED` 的四个浮层里 —— 它不是浮层，是这一屏的地方。 */ null}
    <div class="mod-host" data-mod-slot="screen.room.aside"></div>
    <${RoomModsPanel} room=${room} myId=${me.playerId} onAlignment=${setAlign} />
    <${ChatPanel} />
    <div class="mod-host" data-mod-slot="screen.room.chat"></div>
    <footer class="room-bar rs-foot">
      <div class="rs-foot__left" aria-hidden="true"></div>
      <div class="rs-foot__center">
        <p class="rs-hint">${coop ? html`<span class="rs-ready num" title=${t('已就绪')}>${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}<b>${facts.readyHumans}</b>/${facts.humans.length}</span>` : null}<span class="room-bar__status">${statusLine}</span></p>
        <div class="rs-pill">
          <button type="button" class=${`rs-pill__diff${facts.isHost ? '' : ' is-ro'}`} disabled=${facts.isHost && !!busy} onClick=${openProto}
            title=${facts.isHost ? t('更改模拟难度') : t('由创建者选择')}><${DifficultyIcon} difficulty=${room.difficulty} />${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num rs-pill__code">${info.code}</span></button>
          ${versionCtl ? html`<${Tooltip} text=${versionCtl.why} class="rs-pill__version"><button type="button" class=${`rs-pill__ver${versionCtl.editable ? '' : ' is-ro'}`} data-testid="room-version"
            disabled=${versionCtl.disabled} onClick=${versionCtl.onOpen} aria-label=${t('游戏版本：{name}', { name: versionLabel(curVersion) })}><${Icon} name="book" /><span class="rs-pill__vername">${versionLabel(curVersion)}</span></button><//>` : null}
          ${aiLast || soloOpt ? html`<button type="button" class=${`rs-pill__gear${opts ? ' is-on' : ''}`} onClick=${() => setOpts((v) => !v)} title=${aiLast ? t('同盟设置') : t('模拟设置')} aria-label=${aiLast ? t('同盟设置') : t('模拟设置')}
            aria-expanded=${opts ? 'true' : 'false'}><${GearGlyph} /></button>` : null}
          ${opts && (aiLast || soloOpt) ? html`<${RoomOptions} takeoverOption=${aiTakeoverOption(room, me.playerId)} onAiTakeover=${setAiTakeover} option=${aiLast} soloOption=${soloOpt} room=${room} isHost=${facts.isHost} busy=${busy} onAiLast=${setAiLast}
            onSoloUnlimited=${setSoloUnlimited} onDifficulty=${openProto} onSeatCap=${setSeatCap} onClose=${() => setOpts(false)} version=${versionCtl} />` : null}
        </div>
      </div>
      <div class="room-bar__right rs-foot__right">
      <${SupportButton} from="room" size="md" class="room-support" />
        ${facts.isHost
          ? html`<${Tooltip} text=${facts.canStart ? null : vote ? t('切换版本投票进行中，请等投票结束') : !facts.contentReady ? (facts.versionRoom ? t('仍有博士未载入「{version}」的数据', { version: versionLabel(curVersion) }) : t('仍有博士未载入房间的插件内容')) : t('仍有博士未准备就绪')}>
              <${GoButton} label=${t('开始模拟')} loading=${busy === 'start'} disabled=${!facts.canStart || !online || busy === 'start' || !!vote || soloAlignBlocked} title=${soloAlignBlocked ? t('本机缺少本房间声明的模组，补齐后才能开始') : null} onClick=${start} />
            <//>`
          : facts.spectating
            ? html`<${GoButton} label=${t('观战中')} icon="eye" disabled=${true} />`
          : html`<${Tooltip} text=${!myReady && facts.myContent !== 'ready' ? (facts.versionRoom ? t('「{version}」的数据载入并通过校验后才能准备', { version: versionLabel(curVersion) }) : t('房间的插件内容载入并通过校验后才能准备')) : null}>
              <${GoButton} label=${myReady ? t('已就绪') : t('准备就绪')} ready=${myReady} loading=${busy === 'ready'}
                disabled=${!online || !facts.mine || busy === 'ready' || (!myReady && facts.myContent !== 'ready') || alignBlocked} onClick=${toggleReady} />
            <//>`}
      </div>
    </footer>
    ${picking ? html`<${CardPicker} current=${myCard} list=${cardList} m=${data.get('assets')} localSkins=${localSkins} onPick=${pickCard} onClose=${() => setPicking(false)} />` : null}
    ${protoOpen ? facts.isHost
      ? html`<${ProtocolSelect} roomMode=${room.mode} difficulty=${protoPick || room.difficulty} onDifficulty=${setProtoPick} onClose=${closeProto}
          onCreate=${confirmDifficulty} busy=${busy === 'diff' ? 'create' : null} online=${online} action=${t('确认')} hint=${protoHint} difficulties=${protoDifficulties} />`
      : html`<${ProtocolSelect} roomMode=${room.mode} difficulty=${room.difficulty} onDifficulty=${() => {}} onClose=${closeProto}
          online=${online} readOnly=${true} difficulties=${protoDifficulties} />` : null}
    ${versionOpen && versionCtl ? html`<${VersionPicker} mode="room" versions=${versions || [{ id: curVersion, roomModes: [room.mode] }]} current=${curVersion}
      serverDefault=${serverDefault} roomMode=${room.mode} editable=${versionEditable && !versionWhy} busy=${busy === 'version'}
      note=${versionEditable ? versionWhy || (facts.humans.length > 1 ? t('其他博士同意后才会切换；切换后需要重新准备。') : null) : t('由创建者发起')}
      onPick=${proposeVersion} onClose=${() => setVersionOpen(false)} />` : null}
  </div>`;
}

/** Persistent across room/game routes, including spectators who never consent. */
export function TrustedNotice() {
  const state = useStore(s => s);
  const room = state.room, cs = room?.content?.cs, trusted = room?.content?.trusted;
  const seat = room?.seats?.find(s => s && s.playerId === state.me?.playerId);
  const [dismissed,setDismissed] = useState(null);
  const [busy,setBusy] = useState(false);
  const [review,setReview] = useState(false);
  const choose = async accept => {
    setBusy(true);
    try {
      if (seat) await net.request('room.consent',{cs,accept});
      rememberScriptConsent(cs,accept);
      setDismissed(cs); setReview(false);
      if (accept && trusted.plugins.some(p => p.permissions.includes('trusted.page'))) {
        const url = new URL(location.href); url.searchParams.set('cs',cs); url.searchParams.set('room',room.code);
        location.assign(url.href); return;
      }
      store.set({room:{...store.get().room}}); // wake the content loader after local persistence
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (trusted && seat && hasScriptConsent(cs) && !trusted.consent?.[seat.seat] && !room.inMatch) {
      net.request('room.consent',{cs,accept:true}).catch(toastError);
    }
  },[cs,seat?.seat,!!trusted?.consent?.[seat?.seat]]);
  if (!trusted) return null;
  return html`<aside class="trusted-banner" data-testid="trusted-banner">
    <strong>${t('受信任插件')}</strong>
    <button onClick=${() => setReview(true)}>${t('查看风险与同意状态')}</button>
    <${Modal} open=${review || (dismissed !== cs && !hasScriptConsent(cs))} title=${t('受信任插件')} tone="red" closeOnBackdrop=${false}
      onClose=${() => room.inMatch ? setReview(false) : choose(false)} actions=${html`<${Button} disabled=${busy} onClick=${() => choose(false)} data-testid="script-decline">${t('拒绝')}<//>
        <${Button} disabled=${busy} onClick=${() => choose(true)} data-testid="script-accept">${t('同意运行')}<//>`}>
      <p>${t('它可以完全控制你的游戏页面')}</p>
      <p>${t('仅在你信任所有作者及以下代码时同意。换了内容组合需要重新同意。')}</p>
      <ul>${trusted.plugins.map(p => html`<li key=${p.id}><strong>${p.id} ${p.version}</strong>
        <p>${t('作者：{authors}',{authors:(p.authors || []).join(', ') || '—'})}</p>
        <p class="trusted-hash">SHA-256: ${p.hash}</p><p>${t('权限：{permissions}',{permissions:p.permissions.join(', ')})}</p></li>`)}</ul>
    <//>
  </aside>`;
}
