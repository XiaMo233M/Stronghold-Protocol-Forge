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
// Cosmetic plugins (DESIGN §34 P1a): installContent (content.js) lays the room's visual set and the player's personal
// plugins over the art manifest every screen reads. Gameplay plugins (§32.6): installContentSet (content.js) downloads and
// checks a room's content set and makes it the data every screen and the battle runner read.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, MicroLabel, closeAllDialogs, confirmDialog } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError } from './net.js';
import { store, useStore, emptyMatch, selectRoute, entryGateBlocked, sessionResetNotice, isSpectating } from './store.js';
import { applyPublic } from './matchDelta.js';
import { data } from './data.js';
// 战斗读数（DESIGN §28.38）：注入给注册点的**只有** `battleRunner.damage` 一个函数（`ctx.battle.damage()`），
// 面板拿不到 runner 句柄、拿不到 `Battle`、拿不到 `_entries`。非浏览器环境里这个导出是 `null`，那一格就是 `null`
// （一行日志，不抛）—— 与 `net` / `settings` 两条注入面同一个形状。
import { battleRunner } from './battle/runner.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { TitleScreen, sanitizeName } from './screens/title.js';
import { LobbyScreen, rememberRoom } from './screens/lobby.js';
import { deepLinkSeeds, stripDeepLinkParams, runSoloPlaytest } from './playtestLink.js';
import * as roomMods from './roomMods.js';
import { RoomScreen, TrustedNotice } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { audio, installAudio } from './audio.js';
import { probeDubs } from './voiceDubs.js';
import { settingsStore, setVoiceLangByChar } from './ui/settings.js';
import { voiceLangFor } from './ui/gameLogic/settings.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport } from './ui/device.js';
import { registerImportedAssetWorker } from './assetCache.js';
import { LoadoutHost } from './screens/loadout.js';
import { SupportHost } from './screens/support.js';
import { StatsHost } from './screens/stats.js';
import { installRehearsal } from './battle/rehearsal.js';
import { recordResult, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync } from './ui/loadoutSync.js';
import { installSupportSync } from './ui/supportSync.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';
// W7（DESIGN §28.53）：深链自动入座撞上「本房间声明了模组」时，弹窗的标题就是这条错的文案本身
// （`ERR_TEXT` 那一份，与 `toastError` 走的是同一个 msgid —— 一句话只有一种说法）。
import { ERR_TEXT } from '../../shared/constants.js';
import { recordError, installTrafficMeter } from './diag.js';
import { installContent, installContentSet } from './content.js';
import { cosmetics } from './cosmetics.js';
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
// 第一个渲染的容器。组件级改写（DESIGN §28.19）在**渲染期**生效，所以链注册完成之后已经画出来的那一帧要重画一次 ——
// 重画就是再 `render` 同一个 `<App/>`（Preact 就地 diff，状态不丢）。boot 之前它是 `null`：那时还没有东西需要重画。
let appRoot = null;

const modPanels = createPanelRegistry({
  store,
  net,
  // 数据口（业主裁决 2026-10-10）：面板经 `ctx.data.get('<表>')` 读**冻结快照**。注入的是页面本来就在用的那一个
  // 数据层（`public/js/data.js`），所以读一张表不会多一个请求 —— 它读的就是引擎已经抓过的那份内容。
  data,
  // 面板的**设置读数**与**唯一一个设置写口**（业主裁决 2026-10-11）：`ctx.me.voice` 读的就是引擎自己那一份设置库
  // （`ui/settings.js` 的 `settingsStore`），`ctx.session.setVoiceLang(charId, lang)` 写的就上面那个受限函数
  // （只改 `voiceLangByChar` 一格、过同一份 sanitize、走同一条 `savePref` 订阅）。注入的是**两样函数**，不是
  // store 句柄 —— 面板读得到配音、改得动这一格，别的设置既读不到也写不了。
  settings: { get: () => settingsStore.get(), setVoiceLang: setVoiceLangByChar },
  // 战斗读数（DESIGN §28.38）：`ctx.battle.damage()` 读这一场战斗的逐单位 / 逐人累计伤害 + 时间基准。
  // 注入的是**一个函数**，不是 runner 句柄 —— 与 settings / data 同一条边界（不传什么就是边界）。
  battle: battleRunner,
  notify: (text, kind) => toast(text, kind || 'warn'),
  // 组件级改写（DESIGN §28.19）：`client.panels[].wraps` 注册完成、链表真的变了才调用一次。没有包声明 `wraps`
  // 的服务器上它一次都不会被调用 —— 页面上不多一次渲染、不多一个新全局（与面板那条不变量逐字相同）。
  onWrapsChanged: () => { if (appRoot) render(html`<${App} />`, appRoot); },
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
/** The rehearsal installer (battle/rehearsal.js): its tasks follow the match on screen (see wireNet's store hook). */
let rehearsal = null;
let playtestTimer = null;
/**
 * The materialized m.public view: the full frame the server sent plus every incremental frame merged into it
 * (public/js/matchDelta.js, DESIGN §8.2 "incremental frame"). The store gets THIS, so nothing downstream sees a delta.
 * Cleared whenever the match state is dropped (leaving a room, a fresh welcome), because a delta then has nothing to
 * merge into and the server must send a full frame again — which it does for every joining / returning client.
 * @type {Record<string, any> | null}
 */
let publicState = null;
/** When the last `g.publicFull` ask was sent, so a broken stream cannot turn the self-healing ask into a flood. */
let publicFullAskedAt = 0;
/** The minimum gap between two `g.publicFull` asks (the server answers both the ask and the room's next full frame). */
const PUBLIC_FULL_ASK_MS = 2000;

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
      // W7（DESIGN §28.53）：`?room=` 深链落地时房间声明了模组 ⇒ 服务端回 `MOD_CONSENT_REQUIRED`。深链是**自动**
      // 入座，所以这里必须问一次（与大厅、房间里那两处共用 `roomMods.consentRetryPayload` 决定的重发载荷）；
      // 不弹窗、直接重发就等于把「同意」退化成一次静默重试。
      const retry = roomMods.consentRetryPayload(err, code);
      if (!retry) { toastError(err); return; }
      const ok = await confirmDialog({ title: t(ERR_TEXT.MOD_CONSENT_REQUIRED), text: String(err.detail || ''), micro: 'ROOM MODS' });
      if (!ok) { toastError(err); return; }
      try { await net.request('room.join', retry); } catch (again) { toastError(again); }
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
  identity.rememberMatch(null);
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  publicState = null;                        // the next m.public must be a full frame (the server sends one)
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [] });
  store.patch('ui', { restoring: false });
}

/** The unofficial plugins a server counts in welcome / /healthz `content.plugins` (absent: none — DESIGN §34 P1a). */
const pluginCount = (content) => (content && Number.isInteger(content.plugins) && content.plugins > 0 ? content.plugins : 0);

function onWelcome(msg) {
  identity.saveToken(msg.token);
  identity.rememberMatch(null);
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
  identity.saveName(name);
  store.set({
    me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null },
    // the server's content identity (DESIGN §34): the diagnostics name it (diag.js contentLine)
    content: msg.content && typeof msg.content.vanilla === 'string' ? { vanilla: msg.content.vanilla } : null,
    // how many unofficial plugins it has (P1a — absent: none; content.js fetches the catalogue only when there are some)
    installedPlugins: pluginCount(msg.content),
  });
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
      if (s.match.public && matchAt < welcomeAt) { patch.match = emptyMatch(); publicState = null; }
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
    publicState = null;
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) { publicState = null; store.set({ match: emptyMatch() }); }
  store.set({ room });
  // The picks were made FOR the room we just entered (host) or joined: the next create starts from none, so a pick can
  // never leak into a room the player did not choose it for (roomMods.js).
  if (!prevRoom && room) {
    roomMods.clearSelection();
    if (store.get().roomMods.selected.length) store.set({ roomMods: { ...store.get().roomMods, selected: [] } });
  }
  identity.rememberMatch(room.inMatch && seats.some((seat) => seat?.playerId === myId)
    ? { name: store.get().me.name, code: room.code || '' } : null);
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
    } else if (navigator.serviceWorker?.controller) {
      // 自愈阀（劫持修复 ②）：这次握手服务器**没有**声明任何 assets，而本页确实被一个根作用域 SW 控制着 ⇒ 那个
      // SW 现在只会对 `/assets|/fonts|/media` 回 412（`resources/service.js` 绝不回源），必须是它让路。业主现象：
      // 升级后图标 / 立绘 / 3D 场景全不出来、强刷才好 —— 那是「一次注册 = 永久劫持」：服务器不再声明，页面就
      // 不再注册，可老 SW 还控制着页面。
      // 动态 import 是刻意的：从没装过 SW 的干净环境不会因为这一格多取一个字节（「不声明 assets ⇒ 无新请求」仍是
      // 结构性的，而不是靠一个 `if` 拦出来的）。失败只记诊断，不打断任何东西。
      import('./resources/release.js')
        .then((release) => release.releaseResourceWorker())
        .then((r) => { if (r.unregistered.length) console.info(`[mod-assets] released resource worker (${r.unregistered.join(', ')})`); })
        .catch((err) => recordError('mod-assets', err, 'resource worker release failed'));
    }
    if (Array.isArray(msg && msg.modPanels) && msg.modPanels.length) modPanels.apply(msg.modPanels);
    // 包写的主题变量（业主裁决 2026-10-10）：与 `modPanels` 同一条不变量 —— 服务端没有包声明主题就没有这个字段，
    // 这里一次都不调，页面不多一条 CSS 自定义属性。
    if (msg && msg.modTheme && typeof msg.modTheme === 'object') modPanels.applyTheme(msg.modTheme);
  });
  // 只注册一次：上游 0.2.3 这个处理器是本仓库原版的**超集**（同样 toastError，另加 SESSION_IN_USE 时作废本机令牌），
  // 两处都留会让同一个握手错误弹两次提示。
  net.on('helloError', (err) => {
    if (err.code === 'SESSION_IN_USE') identity.rejectToken();
    toastError(err);
  });
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('m.public', (msg) => {
    // The incremental frame (DESIGN §8.2): a delta carries only what changed and is merged into the last materialized
    // view. A frame that cannot be merged (no baseline yet, a patch naming an unknown shape) is NOT applied — the client
    // asks for the full frame again instead, which is the self-healing path the server also drives on its own with a
    // periodic full frame. `publicState` is what every screen reads; the wire's `delta` never reaches the store.
    const res = applyPublic(publicState, msg);
    if (!res.ok) {
      if (Date.now() - publicFullAskedAt >= PUBLIC_FULL_ASK_MS) {
        publicFullAskedAt = Date.now();
        try { net.send('g.publicFull'); } catch { /* offline: the reconnect's full frame answers it */ }
      }
      return;
    }
    publicState = res.state;
    matchAt = Date.now();
    store.patch('match', { public: publicState });
    maybeFinishRestore();
  });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  // 盟约叠层（上游 0.2.5）：备战期自己的一次层数增长。这条是 ephemeral 的 —— 重连与战果补发都不重放，
  // 所以收到即响，不需要（也不能）从别的 state 推出来。只响本人、只在 game 路由。
  net.on('m.layer', (msg) => {
    const s = store.get();
    if (selectRoute(s) === 'game' && msg.playerId === s.me?.playerId) audio.layerGain(msg.bondId, msg.add);
  });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => {
    const res = payload(msg);
    store.patch('match', { result: res });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    // (`vs`: the room's cosmetic plugins, recorded — such a match still counts as the original game: ui/stats.js)
    // (`content`: the room's content set when it played gameplay plugins — such a match is unofficial: ui/stats.js)
    recordResult(res, { myId: store.get().me.playerId, roomMode: store.get().room?.mode ?? null, vs: store.get().room?.content?.vs ?? null, content: store.get().room?.content ?? null, now: Date.now() });
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
    // the match on screen is over (left, closed, kicked, a new session): a rehearsal task of it is dead, and the frame
    // that cancels it may never arrive (a disposed match sends nothing) — the page stops what it is running itself
    if (selectRoute(prev) === 'game' && selectRoute(s) !== 'game') rehearsal?.clear();
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
  // a room with gameplay plugins: content.js downloads its content set's files instead (DESIGN §34.6)
  const go = () => { if (store.get().room?.content?.vanilla === false) return; data.loadAll(GAME_FILES).catch(() => {}); };
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
    <${TrustedNotice} />
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
  // what this page downloads, by category, for the 问题反馈 report's traffic line (diag.js; nothing is sent anywhere)
  installTrafficMeter();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // Hashed art a player imported. HTTPS or localhost only; a failure here must not stop boot.
  void registerImportedAssetWorker();
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
  // the room's cosmetic plugins and the player's own over the art manifest (content.js; nothing is fetched without them)
  installContent({ toast });
  // a room with gameplay plugins: its content set downloaded, checked and shown (content.js — DESIGN §34.6)
  installContentSet({ toast });
  // A bot prep's layout rehearsal the server offers this host's browser (DESIGN §14, SP_BOT_REHEARSAL=host on the
  // server): a same-origin module Worker simulates the candidates off the main thread and answers with its pick; a
  // browser that cannot run one answers `error` and the server rehearses itself. Nothing happens while the server
  // does not delegate. A gameplay-plugin room is never offered (the server keeps that rehearsal).
  rehearsal = installRehearsal({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // 配音语言 (v0.7.1): read at every line, so switching a dub in 设置 / 干员详情 takes effect on the next line.
  installAudio({
    getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute,
    settings: settingsStore.get(),
    voiceLangOf: (charId) => voiceLangFor(settingsStore.get(), charId),
    // a cosmetic plugin's sound that will not load falls back like its art (content.js, DESIGN §34 P1a)
    onFailed: (url) => cosmetics.fail(url),
  });
  // …and the music follows the art: the screen's track again when the cosmetic layers change its URLs
  cosmetics.subscribe(() => audio.refreshBgm());
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
  appRoot = root; // 组件级改写（§28.19）注册完成之后要重画的正是这一个根

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
      // the same /healthz names how many plugins the server has: the title screen shows it before any hello
      // 同一个 /healthz 也说了服务器装了几个插件、有没有公告：标题屏在任何 hello 之前就要显示它们
      onHealth: (h) => {
        const n = pluginCount(h.content), notices = h.content?.notices === true;
        if (n !== store.get().installedPlugins || notices !== store.get().installedNotices) store.set({ installedPlugins: n, installedNotices: notices });
      },
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
