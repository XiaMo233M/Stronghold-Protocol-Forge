// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Deep link `?playtest=1[&difficulty=KEY]` (the Forge 一键试玩 button): the same gate, but it creates its own
// solo room and starts the match straight away — solo rooms hold exactly one human and no AI, so room.start
// needs nobody else ready (server/lobby.js start()). An unknown / missing difficulty falls back to the lobby
// default. Both deep links are implemented in playtestLink.js (the parser stands beside parseRoomParam in
// screens/lobby.js) so the sequence can be unit-tested without booting this module.
// A consumed deep link is stripped from the URL (history.replaceState), so a reload cannot re-trigger it;
// without any parameter the client behaves exactly as it did before.
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError } from './net.js';
import { store, useStore, emptyMatch, selectRoute, entryGateBlocked, sessionResetNotice, isSpectating } from './store.js';
import { data } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { TitleScreen, sanitizeName } from './screens/title.js';
import { LobbyScreen, rememberRoom } from './screens/lobby.js';
import { deepLinkSeeds, stripDeepLinkParams, runSoloPlaytest } from './playtestLink.js';
import * as roomMods from './roomMods.js';
import { RoomScreen } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { installAudio } from './audio.js';
import { probeDubs } from './voiceDubs.js';
import { settingsStore } from './ui/settings.js';
import { voiceLangFor } from './ui/gameLogic/settings.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport } from './ui/device.js';
import { LoadoutHost } from './screens/loadout.js';
import { SupportHost } from './screens/support.js';
import { StatsHost } from './screens/stats.js';
import { recordResult, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync } from './ui/loadoutSync.js';
import { installSupportSync } from './ui/supportSync.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';
import { recordError } from './diag.js';
import { createPanelRegistry } from './ui/extensions.js';

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = 20;

const SCREENS = { title: TitleScreen, lobby: LobbyScreen, room: RoomScreen, game: GameScreen };

/**
 * C 层注册点 (DESIGN §28.8, docs/WORKSHOP.md §1.9.3): one per page. A pack's panel gets the frozen surface
 * `public/js/ui/extensions.js` builds — no store handle, no `net` object itself (only the two-method facade), no engine
 * and no match — and the module list arrives in `welcome.modPanels` (src of truth: `pack.json.client.panels`, served
 * from `/workshop-panels/`). A server whose packs declare no `client` never sends the field: nothing here is called, no
 * module is imported and **no DOM is added** — the slot containers are created on demand by the registry (the four
 * overlay ones) or rendered by the components themselves (the five host ones), never by this shell.
 */
const modPanels = createPanelRegistry({
  store,
  net,
  // 数据口（业主裁决 2026-10-10）：面板经 `ctx.data.get('<表>')` 读**冻结快照**。注入的是页面本来就在用的那一个
  // 数据层（`public/js/data.js`），所以读一张表不会多一个请求 —— 它读的就是引擎已经抓过的那份内容。
  data,
  notify: (text, kind) => toast(text, kind || 'warn'),
});

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

/** Mutating wrapper of stripDeepLinkParams for the live page: a consumed deep link must never fire twice. */
function clearDeepLinkParams() {
  stripDeepLinkParams(location, history);
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
let playtestTimer = null;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearDeepLinkParams();
}

function clearPendingPlaytest() {
  store.patch('ui', { pendingPlaytest: null });
  clearDeepLinkParams();
}

/**
 * Extra fields for a solo quick start (the `?playtest=` deep link): the mod digest this server declared, if any.
 * `runSoloPlaytest` calls it only for `room.create`, and it returns `{}` on a plain install — the request stays exactly
 * what it was (public/js/roomMods.js buildCreatePayload).
 */
const roomModFields = () => {
  const { mods } = roomMods.buildCreatePayload('solo', '');
  return mods ? { mods } : {};
};

/** One-click playtest once entered + online (idempotent): the `?playtest=` deep link, consumed here. */
function schedulePendingPlaytest() {
  clearTimeout(playtestTimer);
  playtestTimer = setTimeout(() => {
    const s = store.get();
    if (!s.ui.pendingPlaytest || !s.session.entered || net.status !== 'online') return;
    // 闸门未就绪时不烧掉深链（缺口 8）：否则这一条会自动发 room.create，然后被服务端准入拒一次、弹一次红条。
    if (entryGateBlocked(s)) return;
    // The deep link is spent either way: consumed when the match starts, abandoned when it was refused.
    // `roomFields` is what makes a solo quick start work on a MODDED server too: without the digest the gate refuses
    // `room.create` with BAD_MSG, and a plain install sends exactly `{ mode, difficulty }` as before (roomMods.js).
    runSoloPlaytest(net, store, {
      difficulty: s.ui.pendingPlaytest.difficulty,
      roomFields: roomModFields,
      notify: (text, kind) => toast(text, kind || 'info'),
      notifyError: toastError,
    }).finally(clearPendingPlaytest);
  }, JOIN_DELAY_MS);
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !s.session.entered || net.status !== 'online') return;
    // 同上：`?room=` 深链不能绕过闸门（缺口 8）。
    if (entryGateBlocked(s)) return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      await net.request('room.join', roomMods.buildJoinPayload(code));
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [] });
  store.patch('ui', { restoring: false });
}

function onWelcome(msg) {
  identity.saveToken(msg.token);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  // 工坊 mod set (W-A): what this server runs. The client must echo this digest to enter a room, and the lobby renders
  // its pack list as the room-declaration picker. A server that changed under us (restart, another pack root) must not
  // leave a pick from the old catalogue selected — setWelcomeMods drops it and returns false (see roomMods.js).
  const sameMods = roomMods.setWelcomeMods(msg);
  store.set({
    roomMods: {
      available: roomMods.availableMods(),
      selected: sameMods ? prev.roomMods.selected : roomMods.getSelectedModIds(),
    },
  });
  store.set({ me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null } });
  welcomeAt = Date.now();

  if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    if (notice) toast(t(notice), 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  schedulePendingJoin();
  schedulePendingPlaytest();
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectating(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  store.set({ room });
  // The picks were made FOR the room we just entered (host) or joined: the next create starts from none, so a pick can
  // never leak into a room the player did not choose it for (roomMods.js).
  if (!prevRoom && room) {
    roomMods.clearSelection();
    if (store.get().roomMods.selected.length) store.set({ roomMods: { ...store.get().roomMods, selected: [] } });
  }
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
};

function wireNet() {
  net.on('status', (snap) => {
    const cur = store.get().connection;
    store.set({
      connection: {
        status: snap.status, ping: snap.ping, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || snap.status === 'online',
      },
    });
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  // C 层注册点（DESIGN §28.8）：包声明的面板清单随 `welcome` 到达。没有包声明 `client` 时这个字段根本不出现 ——
  // 于是这次握手、这次订阅之后的行为、以及页面上的一切都与从前逐字节相同（没有新请求、新 DOM、新全局）。
  net.on('welcome', (msg) => {
    // 资源声明（DESIGN §28.13.5）：包只**声明**容器与策略，SW 与整条流程是引擎的。这里刻意用 **动态 import** ——
    // 没有声明时 `public/js/resources/host.js` 及其依赖根本不进浏览器，于是「不声明 ⇒ 无字段、无新请求、无新 DOM、
    // 无新全局」是结构性的，而不是靠几个 `if` 拦住的。
    if (Array.isArray(msg && msg.modAssets) && msg.modAssets.length) {
      import('./resources/host.js')
        // 引擎自带的 SW 由 host 在**后台**注册（`resources/worker.js`）：入口放行绝不等待它。
        .then((host) => host.installModAssets(msg.modAssets, { log: console }))
        // 这条 `.catch` 是 B4 §6 第 6 条补的：资源流程的模块拉不下来时（网络断在部署中间、模块 404、语法错误），
        // 以前只有一行 `recordError` 进诊断记录，**页面上什么都不说** —— 玩家装了资源包却一直卡在入口闸门上，
        // 而唯一的信号在一个他看不到的地方。照仓库既有的错误通道（toast + describeError）给他一句话，
        // 诊断记录照旧留一份。
        .catch((err) => {
          recordError('mod-assets', err, 'resource host failed to load');
          toast(t('加载模组资源模块失败：{error}', { error: describeError(err) }).slice(0, 160), 'error', { ttl: 8000 });
        });
    }
    if (Array.isArray(msg && msg.modPanels) && msg.modPanels.length) modPanels.apply(msg.modPanels);
    // 包写的主题变量（业主裁决 2026-10-10）：与 `modPanels` 同一条不变量 —— 服务端没有包声明主题就没有这个字段，
    // 这里一次都不调，页面不多一条 CSS 自定义属性。
    if (msg && msg.modTheme && typeof msg.modTheme === 'object') modPanels.applyTheme(msg.modTheme);
  });
  net.on('helloError', (err) => toastError(err));
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => { matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore(); });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => {
    const res = payload(msg);
    store.patch('match', { result: res });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    recordResult(res, { myId: store.get().me.playerId, roomMode: store.get().room?.mode ?? null, now: Date.now() });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // Entering (title → lobby) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    if (s.session.entered && !prev.session.entered) { schedulePendingJoin(); schedulePendingPlaytest(); }
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * in the background once the player is in a room — a match is near (the lobby alone never downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  const go = () => { data.loadAll(GAME_FILES).catch(() => {}); };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function App() {
  const route = useStore(selectRoute);
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  const Screen = SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${route} />`}
    <${ConnectionBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
    <${SupportHost} />
    <${StatsHost} />
  </div>`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

async function boot() {
  installGlobalErrorHandlers();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const identityReady = identity.init();

  const { pendingJoin, pendingPlaytest } = deepLinkSeeds(location.search);
  const savedName = sanitizeName(identity.loadName());
  const entered = identity.wasEntered() && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    // 整片替换会冲掉闸门状态位（缺口 8）：先摊开现有的 session，再强制 `entered`。不堵这里，`identity.wasEntered()`
    // （public/js/net.js 读 localStorage / sessionStorage 的 sp.entered）每次开机都会把 `preloadRequired` 重置掉，
    // 而 `entered` 又因此为真 —— 闸门形同虚设，玩家在素材就绪前照样进大厅。
    session: { ...s.session, entered },
    ui: { ...s.ui, pendingJoin, pendingPlaytest },
  }));

  wireNet();
  installStatsRecorder(store); // follows the match on screen, so a 放弃模拟 can be recorded (ui/stats.js)
  installLoadoutSync({ net });
  installSupportSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // 配音语言 (v0.7.1): read at every line, so switching a dub in 设置 / 干员详情 takes effect on the next line.
  installAudio({
    getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute,
    settings: settingsStore.get(),
    voiceLangOf: (charId) => voiceLangFor(settingsStore.get(), charId),
  });
  data.load('assets').catch(() => {});
  // 配音语言 (v0.7.1): which dubs this install really has (a release bundle ships the default one; the others come as a
  // voice pack from the release page). One HEAD per dub; the settings row and 干员详情 read the result.
  data.load('assets').then(() => probeDubs(data.get('assets'))).catch(() => {});  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});

  const connectWhenReady = identityReady.then(() => {
    if (entered) net.setName(savedName);
    else net.connect();
  });
  // the language (and its UI translations) before the first render: no Chinese flash for an English player
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = { store, net, data, version: 1 };
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
