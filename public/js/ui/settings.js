// Player settings (BGM/SFX/voice volume, the voice dub 语音语言, mute, damage numbers, the optional 弹药数量 under an ammo
// skill's bar — not in the official HUD, off by default, PR #552 —, the optional 作战统计 panel — off by default,
// PR #618 —, render quality, 文字大小, the
// shortcut keys): a tiny observable store persisted in localStorage (`sp.pref.settings`), applied to the audio manager
// and to the document on every change, plus the settings modal — which also holds the language switch (ui/lang.js; kept
// apart in `sp.pref.lang`; under it a note while the current language's pack is a machine translation,
// `_meta.machineTranslated`) and the 快捷键 section that rebinds the in-match shortcuts (the key map:
// ui/gameLogic/shortcuts.js; the community request 「快捷键可不可以自己设置」, the owner's decision of 2026-10-07) and
// 问题反馈, which copies the diagnostics of this page for a bug report (diag.js: the error log, this browser, optionally
// the battle on screen; nothing is uploaded). The lobby and the room open it from a 设置 button next to 玩法说明
// (SettingsButton, GitHub #238); the title screen and the match have their own gear.
//
// **面板那一格（`setVoiceLangByChar`，业主裁决 2026-10-11）。** 这个文件也是「C 层面板能写的**唯一一格**设置」的
// 落点：`ctx.session.setVoiceLang(charId, lang)` 在引擎侧最终调的就是这里的 `setVoiceLangByChar`，它只改
// `voiceLangByChar` 的一个键、过同一份 sanitize、走同一条 `savePref` 订阅。边界写在那个函数的注释里，一句话：
// 面板可以改**这台机器上这个干员说哪种配音**，改不了别的东西，也改不了任何人的战果。
//
// 文字大小 (textSize, applied by applyTextSize): the interface text root `--t` of css/theme.css — a phone clamps the
// layout root `1rem` at 40 px (theme.css), which left the .18rem body text at 7.2 CSS px while the browser's own font
// settings only inflate the glyphs inside fixed boxes (and page zoom is off: index.html's viewport, ui/device.js).
// Only font-size declarations read `--t`, so the board, the HUD bands the prep camera keeps clear and the detail
// card's side do not move — the field is sized from the host element's clientWidth (render/app.js).

import { useLayoutEffect, useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { catalog, personalApplied, isPersonalCosmetic, cosmeticPlugins, installedCount, loadCatalog, personal, personalSet, pluginName, setPersonalPlugin } from '../content.js';
import { resolveThemeVars, themeVarsOf } from '../../../shared/plugins/theme.js';
import { hasAnySkinChoices } from './skins.js';
import { describeError, toast } from './toasts.js';
import { pluginMicro } from './pluginTag.js';
import { fxAvailable } from '../render/vfx/available.js';
import { resolveOfficialFx } from '../render/vfx/tier.js';
import { html, Modal, Button, Icon, MicroLabel } from './components.js';
import { createStore, useStore, loadPref, savePref, store } from '../store.js';
import { GIcon } from './gameComponents.js';
// 本仓库的语音词表是共用的那一份（shared/constants.js），所以这里不要 VOICE_LANGS：
// 设置页列的是 `availableVoiceLangs()` 收窄后的「本机真的装了哪些配音」，语言名走 VOICE_LANG_NAMES。
// 上游 0.2.3 的四档文字大小需要 TEXT_SIZES。
import { sanitizeSettings, HOTKEY_ACTIONS, DEFAULT_HOTKEYS, hotkeyLabel, rebindHotkey, isDefaultHotkeys, captureHotkey, availableVoiceLangs, TEXT_SIZES, sanitizeVoiceLangByChar } from './gameLogic.js';
// 工坊外观 (workshopSkins): the switch itself lives in the settings store, but the **gate the chain reads** is one
// module-level value in portraitChain.js — this file is its only writer (boot below + the subscription under it).
import { setAppearanceFirst } from './portraitChain.js';
// 工坊素材加载源 (workshopSources): the same shape — the switch lives in the settings store, and the **gate the mirror
// ordering reads** is one module-level value in resources/sources.js; this file is its only writer.
import { setSourcesEnabled } from '../resources/sources.js';
import { VOICE_LANG_NAMES } from '../../../shared/constants.js';
import { data, useData } from '../data.js';
import { dubsInstalled, dubsMissing } from '../voiceDubs.js';
import { audio } from '../audio.js';
import { openGuide } from './guide.js';
import { detectFeatures } from './device.js';
import { LangToggle, machineTranslationNote } from './lang.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { errorCount, currentBattle, diagnosticsText } from '../diag.js';
import { copyText } from './clipboard.js';
// 异形屏适配 (ui/screenFit.js): imported here, ahead of main.js's first render, so the stored offsets are on at boot
import { ScreenFitSection } from './screenFit.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Settings store: { bgm, sfx, voice, voiceLang, voiceLangByChar, muted, damageNumbers, officialDamageNumbers, workshopSkins, workshopSources, ammoEnergyCount, quality, textSize, keys }. */
export const settingsStore = createStore(sanitizeSettings(loadPref('settings', null)));

/**
 * 设置 →「文字大小」: put the step on <html data-text> — css/theme.css turns it into the text root `--t`
 * (`:root[data-text="md"] { --t: … }`), which every readable font-size reads; no layout value does. The attribute
 * (not an inline style) keeps the default in the stylesheet: without it — no JavaScript, an old saved profile, a
 * value a future version dropped — the page is the design's own sizes. Values outside TEXT_SIZES fall back to 小.
 * @param {'sm'|'md'|'lg'|'xl'} v
 */
export function applyTextSize(v) {
  const el = globalThis.document?.documentElement;
  if (el) el.dataset.text = TEXT_SIZES.includes(v) ? v : 'sm';
}

settingsStore.subscribe((s) => {
  savePref('settings', sanitizeSettings(s));
  audio.setVolumes(s);
  // 只传全局那一个配音：逐干员的覆盖由 main.js 注入的 voiceLangOf 在播放时读取（单一真相，见 audio.js 那一处）。
  audio.setVoiceLang(s.voiceLang);
  applyTextSize(s.textSize);
  setAppearanceFirst(s.workshopSkins);
  setSourcesEnabled(s.workshopSources);
});
audio.setVolumes(settingsStore.get());
audio.setVoiceLang(settingsStore.get().voiceLang);
// before the first render (main.js boot renders after its imports ran): the stored step is on screen without a flash
applyTextSize(settingsStore.get().textSize);
// 同上：工坊外观的门控也要在**第一帧之前**同步好，否则首帧问的是链的默认值、下一帧才改成玩家的选择
// —— 那是「闪一下再变」，正是这条链存在的理由要避免的那类错（见 portraitChain.js 步骤 0）。
setAppearanceFirst(settingsStore.get().workshopSkins);
// 加载源的门控同样要在第一帧之前同步好：一个声明了镜像的包，第一次导入就在开机路径上。
setSourcesEnabled(settingsStore.get().workshopSources);

/** @param {Partial<ReturnType<typeof sanitizeSettings>>} patch */
export function updateSettings(patch) {
  settingsStore.set(sanitizeSettings({ ...settingsStore.get(), ...patch }));
}

/**
 * **面板能写的唯一一格设置**：某个干员的配音覆盖（`ctx.session.setVoiceLang` 的落点，业主裁决 2026-10-11）。
 *
 * 为什么写在这里、而不是让面板自己去改：设置库与 `savePref` 都在这个文件里，写路径**只能有一条**。这个函数
 * 就是那条路上的一个受限入口 —— 它做的三件事，每一件都是边界：
 *   1. **只改 `voiceLangByChar` 里的一个键**（`next` 是当前表的浅拷贝，`updateSettings` 再 sanitize 一次），
 *      音量 / 静音 / 画质 / 文字大小 / 快捷键 / 工坊外观开关一个字节都不动；
 *   2. 写下去的值过 `sanitizeVoiceLangByChar` —— 与 `sanitizeSettings` **同一份判据**（第二读者）：形状不对的
 *      干员 id、不在 `VOICE_LANGS` 里的语言、超过 `VOICE_OVERRIDE_MAX` 的第 401 个覆盖，都在这里被丢掉，
 *      于是函数返回 `false`，调用方（C 层）**点名**（不是「写了个没反应的东西」）；
 *   3. 持久化走**既有那一条订阅**（本文件顶部的 `settingsStore.subscribe` → `savePref('settings', …)`）：
 *      这里不另调一次 `savePref` —— 同一条写入有两条落盘路径，早晚会漂。
 *
 * 播放时怎么用：`audio.js` 播放时问注入的 `voiceLangOf`（`ui/gameLogic/settings.js voiceLangFor`：覆盖 →
 * 全局 → 默认）。所以这一格**纯本地**：不发帧、不落对局、改不了任何人的战果（「面板可以画错、但不能算错」）。
 *
 * @param {string} charId 干员 id（`char_` + 1..64 个 A-Za-z0-9_）
 * @param {'cn'|'jp'|'en'|'kr'|''|null} lang 配音语言；`''` / `null` = 清掉这一格的覆盖（回到跟随全局）
 * @returns {boolean} 是否真的写进去了（`false` = 被同一份判据拒掉，store 一个字节没变）
 */
export function setVoiceLangByChar(charId, lang) {
  const cur = settingsStore.get();
  const table = cur && typeof cur.voiceLangByChar === 'object' && cur.voiceLangByChar ? cur.voiceLangByChar : {};
  const next = { ...table };
  const clear = lang === '' || lang === null;
  if (clear) delete next[charId]; else next[charId] = lang;
  const judged = sanitizeVoiceLangByChar(next);
  // 判据的**两个方向**都要对：写进去的键留下了，且值就是我们要的那个；清掉的键真的不在了。
  const survived = clear ? !Object.hasOwn(judged, charId) : judged[charId] === lang;
  if (!survived) return false;
  updateSettings({ voiceLangByChar: judged });
  return true;
}

/** Preact hook: current settings. */
export const useSettings = () => useStore((s) => s, Object.is, settingsStore);

/**
 * The label of the key a rebindable shortcut has right now ('R', 'Space' …) — the HUD's key hints (shop bar, ready /
 * pause, underframe). Read at render: the game screen re-renders when the settings dialog closes.
 * @param {'buy'|'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready'} action
 */
export const hotkeyLabelOf = (action) => hotkeyLabel(settingsStore.get().keys?.[action]);

function Slider({ label, micro, value, onInput, icon }) {
  const pct = Math.round(value * 100);
  return html`<label class="set-row">
    <span class="set-row__label"><${Icon} name=${icon} />${label}<${MicroLabel}>${micro}<//></span>
    <input class="set-range" type="range" min="0" max="100" step="5" value=${pct} style=${`--pct:${pct}%`}
      onInput=${(e) => onInput(Number(e.currentTarget.value) / 100)} />
    <span class="set-row__val num">${pct}</span>
  </label>`;
}

function Toggle({ label, micro, value, onChange }) {
  return html`<div class="set-row">
    <span class="set-row__label">${label}<${MicroLabel}>${micro}<//></span>
    <button type="button" class=${`set-toggle${value ? ' is-on' : ''}`} role="switch" aria-checked=${value ? 'true' : 'false'}
      onClick=${() => onChange(!value)}><i></i><span>${value ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
  </div>`;
}

const QUALITY = [['low', N_('低')], ['medium', N_('中')], ['high', N_('高')]];
/**
 * 官方特效 (0.3.0, render/vfx): the official battle effects the server's owner extracted from their own client (the
 * server serves them: every player of that server sees the owner's extraction) — normal attacks, projectiles, hits,
 * statuses, deaths, deploys, the operators' skills and a 秘术师's stored energies; 关 / 精简 / 完整. The stored default
 * 'auto' shows as the tier it resolves to (完整 on a desktop, 精简 on a touch device, render/vfx/tier.js); the row is
 * left out when no effects were extracted (data/local-fx.json lists none).
 */
const OFFICIAL_FX = [['off', N_('关')], ['lite', N_('精简')], ['full', N_('完整')]];
/**
 * 文字大小: one step of TEXT_SIZES (ui/gameLogic/settings.js) with its label — 小 is the design's own sizes, the others
 * raise the text root `--t` (css/theme.css) and with it every readable font-size; the board and the HUD's boxes stay.
 */
const TEXT_SCALES = [['sm', N_('小')], ['md', N_('中')], ['lg', N_('大')], ['xl', N_('特大')]];
// 语音语言: each dub named in its own language, like the interface language switch (ui/lang.js) — the owner's
// 「中文 / 日本語」 (2026-10-08); VOICE_LANGS order. 0.2.2 inlined this table here; this repo reads the shared one
// (shared/constants.js VOICE_LANG_NAMES: cn / jp / en / kr), which the editor and the CLI use as well.
// 上游 0.2.3 在这里另加一份本地 `VOICE_LANG_NAMES`（只有 cn / jp）—— 不采用：那会让设置页比共用词表少两种配音。
/** The rebindable shortcuts' names (msgids), by action. */
const HOTKEY_NAMES = { refresh: N_('刷新商店'), freeze: N_('冻结 / 解冻商店'), levelUp: N_('升级调度中心'), retreat: N_('撤退选中干员'),
  sell: N_('出售选中干员'), ready: N_('准备就绪 / 暂停（独立模拟）') };

/**
 * 快捷键: each shortcut with its key. Click its key (or Enter / Space on it) and press the new one: Esc cancels (the
 * dialog stays open), Tab leaves, a key held with Ctrl / Alt / ⌘ or one the interface keeps is refused, a key another
 * shortcut has is swapped — the line under the list says what happened; 恢复默认 restores the keys of 0.1.4. Esc
 * (cancel / close) is fixed. On a touch-only device the section says the keys need a keyboard and folds the list (an
 * attached keyboard still uses it).
 * @param {{ keys: Record<string, string>, touchUi: boolean }} props
 */
function HotkeySection({ keys, touchUi }) {
  const [waiting, setWaiting] = useState(null); // the action waiting for its new key
  const [note, setNote] = useState(null);       // { text, warn }: the result line
  // a layout effect: the key listener is on as soon as the key shows that it waits (an Esc right after the click must
  // end the wait, never reach the dialog's own Esc)
  useLayoutEffect(() => {
    if (!waiting) return undefined;
    const name = t(HOTKEY_NAMES[waiting]);
    const onKey = (e) => {
      const r = captureHotkey(e);
      if (r.kind === 'leave') { setWaiting(null); return; } // Tab: the focus moves on
      // ahead of the dialog's own Esc (it stays open), a focused button's Enter / Space and every other key handler
      e.preventDefault();
      e.stopImmediatePropagation();
      if (r.kind === 'ignore') return;
      const cur = settingsStore.get().keys;
      if (r.kind === 'cancel') {
        setWaiting(null);
        setNote({ text: t('已取消，「{action}」仍是 {key}', { action: name, key: hotkeyLabel(cur[waiting]) }) });
        return;
      }
      if (r.kind === 'refuse') {
        setNote({ warn: true, text: r.reason === 'modifier' ? t('快捷键只能是单个按键，不能搭配 Ctrl、Alt 或 ⌘')
          : t('{key} 不能设为快捷键：Esc、Tab、Enter、方向键和功能键留给界面使用', { key: r.name }) });
        return;
      }
      const res = rebindHotkey(cur, waiting, r.code);
      updateSettings({ keys: res.keys });
      setWaiting(null);
      const key = hotkeyLabel(r.code);
      setNote({ text: res.swapped
        ? t('「{action}」已改为 {key}；「{other}」原来用 {key}，已换成 {old}', { action: name, key, other: t(HOTKEY_NAMES[res.swapped]), old: hotkeyLabel(res.keys[res.swapped]) })
        : t('「{action}」已改为 {key}', { action: name, key }) });
    };
    // a press anywhere but the waiting key ends the wait (another key starts its own)
    const onDown = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.set-key.is-waiting')) setWaiting(null); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [waiting]);

  const status = note ? note.text : waiting ? t('请按下「{action}」的新按键（Esc 取消）', { action: t(HOTKEY_NAMES[waiting]) }) : '';
  const list = html`<ul class="set-keys__list">
    ${HOTKEY_ACTIONS.map((a) => {
      const on = waiting === a;
      const label = hotkeyLabel(keys?.[a]);
      return html`<li key=${a} class="set-keys__row">
        <span class="set-keys__name">${t(HOTKEY_NAMES[a])}</span>
        <button type="button" class=${cx('set-key', on && 'is-waiting')} data-action=${a} aria-pressed=${on ? 'true' : 'false'}
          aria-label=${t('更改「{action}」的快捷键（当前：{key}）', { action: t(HOTKEY_NAMES[a]), key: label })}
          onClick=${() => { setNote(null); setWaiting((w) => (w === a ? null : a)); }}>
          ${on ? html`<span class="set-key__wait">${t('按下新按键…')}</span>` : html`<kbd>${label}</kbd>`}
        </button>
      </li>`;
    })}
    <li class="set-keys__row is-fixed">
      <span class="set-keys__name">${t('取消 / 关闭')}</span>
      <span class="set-key is-fixed"><kbd>Esc</kbd><small>${t('不可更改')}</small></span>
    </li>
  </ul>
  <p class=${cx('set-keys__note', note?.warn && 'is-warn')} role="status" aria-live="polite">${status}</p>`;
  return html`<section class="set-keys" aria-labelledby="set-keys-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-keys-title">${t('快捷键')}<${MicroLabel}>HOTKEYS<//></span>
      <${Button} variant="ghost" size="sm" icon="refresh" class="set-keys__reset" disabled=${isDefaultHotkeys(keys)}
        onClick=${() => { setWaiting(null); updateSettings({ keys: DEFAULT_HOTKEYS }); setNote({ text: t('已恢复默认快捷键') }); }}>${t('恢复默认')}<//>
    </div>
    ${touchUi ? html`<p class="set-hint">${t('快捷键需要实体键盘；触屏设备连接键盘后可用')}</p>
      <details class="set-keys__more"><summary>${t('查看 / 更改快捷键')}</summary>${list}</details>` : list}
  </section>`;
}

/** Where a report goes: the upstream issue tracker (shown as text the player can select; a link may open nothing). */
export const ISSUES_URL = 'https://github.com/sganggs/Stronghold-Protocol/issues';

/**
 * 问题反馈: copy the diagnostics of this page (diag.js) for a GitHub issue — the errors recorded since the page opened,
 * this browser and device, where the player is, and, switched on by default while a battle is on screen, that battle's
 * spec (the dev tools replay it). Player names, the room code and the token are replaced; nothing is uploaded. Laid out
 * like 快捷键 above it (a head with its button, a hint, the result line); the battle switch is the settings' Toggle, and
 * when the clipboard refuses (some in-app browsers), the report is shown selected in a box styled like 干员调配's 导出.
 */
/** The result line of 复制诊断信息, by outcome (msgids: translated when shown, so a language switch reaches it). */
const DIAG_NOTES = { copied: N_('已复制诊断信息，可以粘贴到 GitHub issue 中'), refused: N_('无法写入剪贴板，请手动复制下面的内容') };

function DiagSection() {
  const [attach, setAttach] = useState(true);
  const [note, setNote] = useState(null);       // 'copied' | 'refused' | null: the result line
  const [manual, setManual] = useState(null);   // the report, when the clipboard refused it
  const boxRef = useRef(null);
  // the box opens selected for a manual copy, scrolled to its first line (select() leaves it at the end)
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (manual && el) { el.focus(); el.select(); el.scrollTop = 0; }
  }, [manual]);
  const n = errorCount();
  const battle = currentBattle();
  const copy = async () => {
    const text = diagnosticsText({ state: store.get(), settings: settingsStore.get(), attachBattle: attach && !!battle, personal: personalApplied() });
    const ok = await copyText(text);
    setManual(ok ? null : text);
    setNote(ok ? 'copied' : 'refused');
  };
  return html`<section class="set-diag" aria-labelledby="set-diag-title">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-diag-title">${t('问题反馈')}<${MicroLabel}>DIAGNOSTICS<//></span>
      <${Button} variant="ghost" size="sm" icon="copy" class="set-diag__copy" data-testid="diag-copy" onClick=${copy}>${t('复制诊断信息')}<//>
    </div>
    <p class="set-hint">${t('遇到问题时，复制诊断信息并粘贴到 GitHub issue 中，开发者就能看到出错时的情况。诊断信息只在本机生成，不会自动上传；玩家名和房间号会被替换。')}</p>
    <div class="set-diag__meta">
      <span class="set-diag__stat">${t('已记录的错误')}<b class=${cx('set-diag__count num', n > 0 && 'is-warn')} data-testid="diag-count">${n}</b></span>
      <span class="set-diag__url">${ISSUES_URL.replace(/^https:\/\//, '')}</span>
    </div>
    ${battle ? html`<${Toggle} label=${t('附上本场战斗')} micro="BATTLE DATA" value=${attach} onChange=${setAttach} />
      <p class="set-hint set-diag__battle-hint">${t('开发者可以用附上的战斗数据重现这场战斗。')}</p>` : null}
    ${note ? html`<p class=${cx('set-keys__note', note === 'refused' && 'is-warn')} role="status" aria-live="polite">${t(DIAG_NOTES[note])}</p>` : null}
    ${manual ? html`<textarea ref=${boxRef} class="set-diag__text" data-testid="diag-text" spellcheck=${false} readOnly
      aria-label=${t('诊断信息')} value=${manual}></textarea>` : null}
  </section>`;
}

/**
 * 配音语言 (v0.7.1): the dub every operator speaks unless 干员详情 → 配音 overrides it for one of them.
 *
 * The dubs the manifest carries (audio.voiceLangs beside the default audio.voice), minus the ones this install does not
 * really have (public/js/voiceDubs.js: a release bundle ships the default dub only and the others come as a voice pack
 * from the release page). 混搭 is the point (owner's request 「不同干员可以切换不同的配音语言」), so the row is a
 * radiogroup and never a 全部 hero — and a missing dub is named instead of silently offered.
 * @param {{ value: string }} props the settings' voiceLang
 */
function CosmeticSection() {
  const cat = useStore((s) => s, Object.is, catalog);
  const ids = useStore((s) => s.ids, Object.is, personal);
  const installed = useStore(installedCount);
  const s = useSettings();
  useEffect(() => { if (installed) loadCatalog({ force: true }); }, [installed]);
  const entries = installed ? cosmeticPlugins(cat.plugins, 'personal') : [];
  const list = entries.filter(isPersonalCosmetic);
  // The 显示其他玩家的皮肤 switch is on screen with or without a PERSONAL plugin — an appearance can also come from a
  // set the player is not in (a watched match's cosmetics are the watcher's own layers), and a switch that appears only
  // when the catalogue happens to have loaded would look like a bug. It follows the same GLOBAL rule the 皮肤 section
  // does (ui/skins.js hasAnySkinChoices: at least one operator of the composed manifest has a wear-able skin), so a
  // session with no such appearance draws nothing here — an installation without a cosmetic layer keeps exactly the
  // settings it had before this feature, the switch included (test/ui/plugins.e2e.test.js asserts the section is absent
  // on a server without plugins). The list below is NOT gated: it is where a switched-off plugin is switched back on.
  if (!list.length) {
    if (!hasAnySkinChoices()) return null;
    return html`<section class="set-plugins" aria-labelledby="set-skins-title" data-testid="personal-plugins">
      <div class="set-keys__head"><span class="set-row__label" id="set-skins-title">${t('外观插件')}<${MicroLabel}>COSMETIC PLUGINS<//></span></div>
      <${OtherSkinsRow} value=${s.otherSkins !== false} onSet=${(v) => updateSettings({ otherSkins: v })} />
    </section>`;
  }
  const set = personalSet(ids, entries);
  const applied = new Set(set.order);
  const auto = new Set(set.auto);
  const winners = resolveThemeVars(set.order.map((id) => {
    const p = entries.find((x) => x.id === id);
    return { id, vars: themeVarsOf(p) };
  }));
  const flip = (id, on) => { const r = setPersonalPlugin(id, on); if ('error' in r) toast(describeError(r.error), 'warn'); };
  return html`<section class="set-plugins" aria-labelledby="set-plugins-title" data-testid="personal-plugins">
    <div class="set-keys__head">
      <span class="set-row__label" id="set-plugins-title">${t('外观插件')}<${MicroLabel}>COSMETIC PLUGINS<//></span>
    </div>
    <p class="set-hint">${t('只改变你自己看到的画面和声音，不影响其他博士，也不影响战斗；插件为非官方制作。')}</p>
    <${OtherSkinsRow} value=${s.otherSkins !== false} onSet=${(v) => updateSettings({ otherSkins: v })} />
    ${winners.map((w) => html`<p key=${w.name} class="set-hint set-theme-win">${t('{token} 由「{name}」生效', { token: w.name, name: pluginName(list.find((p) => p.id === w.pluginId) || { id: w.pluginId }) })}</p>`)}
    ${list.map((p) => {
      // on: applied (chosen, or 「自动」: another one needs it) — or chosen but left out now (a conflict): switch it off
      const skipped = set.skipped.includes(p.id);
      const on = applied.has(p.id) || skipped;
      const isAuto = auto.has(p.id);
      return html`<div key=${p.id} class="set-row" data-plugin=${p.id}>
        <span class="set-row__label">${pluginName(p)}${isAuto ? html` <span class="plugrow__badge">${t('自动')}</span>` : null}<${MicroLabel}>${pluginMicro(p)}<//>
          ${skipped ? html`<span class="set-hint is-warn">${t('与其他已开启的插件冲突或缺少所需插件，没有生效')}</span>` : null}</span>
        <button type="button" class=${`set-toggle${on ? ' is-on' : ''}`} role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${pluginName(p)}
          disabled=${isAuto && !ids.includes(p.id)} onClick=${() => flip(p.id, !on)}><i></i><span>${on ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
      </div>`;
    })}
  </section>`;
}

/**
 * 设置「显示其他玩家的皮肤」 (docs/SKINS.md): whether this browser draws the appearance another player chose
 * (`UnitInfo.skin`, published by the match — `Match.publicView().players[].skins`).
 *
 * Pure client preference, never sent: turning it off makes every OTHER seat's piece draw the operator's own model,
 * 干员调配 its own choice alone. The asymmetry is deliberate and documented — their screen keeps showing their skin, so
 * a co-op's players may see different models for the same piece. On by default: the appearance is what its owner chose
 * it for, and this is the switch for a player who prefers the official model of everyone else.
 * @param {{ value: boolean, onSet: (v: boolean) => void }} props
 */
function OtherSkinsRow({ value, onSet }) {
  return html`<${Toggle} label=${t('显示其他玩家的皮肤')} micro="OTHER SKINS"
    value=${value} onChange=${(v) => onSet(v)} />`;
}

function VoiceLangRow({ value }) {
  useData('assets');
  const all = availableVoiceLangs(data.get('assets'));
  const langs = dubsInstalled(all);
  const absent = dubsMissing(all);
  const packHint = absent.length
    ? html`<p class="set-hint set-voice-lang__pack">${t('未安装的配音：{langs}。从 release 页下载语音包，解压到 app/public/assets/audio/voice/ 即可（清单已经列好，不用改配置）。', { langs: absent.map((l) => VOICE_LANG_NAMES[l] || l).join(' / ') })}</p>`
    : null;
  if (langs.length <= 1) {
    return html`<div class="set-row">
      <span class="set-row__label">${t('配音语言')}<${MicroLabel}>VOICE LANGUAGE<//></span>
      <span class="set-hint set-voice-lang__only">${t('本机只装了默认配音（{lang}）。想要多语言配音，先运行：node tools/fetch-assets.mjs --voice-langs=cn,jp,en,kr，或从 release 页下载语音包', { lang: VOICE_LANG_NAMES[langs[0]] || langs[0] })}</span>
    </div>${packHint}`;
  }
  return html`<div class="set-row">
    <span class="set-row__label">${t('配音语言')}<${MicroLabel}>VOICE LANGUAGE<//></span>
    <div class="set-seg" role="radiogroup" aria-label=${t('配音语言')}>
      ${langs.map((l) => html`<button key=${l} type="button" role="radio" aria-checked=${value === l ? 'true' : 'false'}
        class=${value === l ? 'is-on' : ''} onClick=${() => updateSettings({ voiceLang: l })}>${VOICE_LANG_NAMES[l] || l}</button>`)}
    </div>
  </div>
  <p class="set-hint">${t('单个干员可以在「干员详情 → 配音」里改成别的语言。')}</p>${packHint}`;
}

/**
 * Settings modal.
 * @param {{ open: boolean, onClose: Function }} props
 */
export function SettingsModal({ open, onClose }) {
  const s = useSettings();
  const [tested, setTested] = useState(false);
  const [touchUi] = useState(() => detectFeatures().coarse && !detectFeatures().fine);
  const mtNote = machineTranslationNote(); // a pack marked as machine translation says so under the switch
  const [fxOk, setFxOk] = useState(false);  // effects extracted from the local client: the 官方特效 row shows
  // only while it is open (the title page keeps the modal mounted, closed), and from the effects' own file list: the
  // asset store (assets.js) is not loaded before a match (test/ui/plugins.e2e.test.js). A Phase 1a extraction (0.3.0
  // development builds only) listed its effects in data/local-assets.json instead and shows no row: re-extract.
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    fxAvailable(null).then((ok) => { if (live) setFxOk(!!ok); }, () => {});
    return () => { live = false; };
  }, [open]);
  const fxTier = resolveOfficialFx(s.officialFx, true);
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('设置')} micro="SETTINGS" width="7.4rem"
                        actions=${html`<${Button} variant="secondary" icon="book" class="set-guide" onClick=${() => openGuide(0)}>${t('玩法说明')}<//>
                        <${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="set-list">
      <div class="set-row">
        <span class="set-row__label">${t('语言')}<${MicroLabel}>LANGUAGE<//></span>
        <${LangToggle} class="set-lang" />
      </div>
      ${mtNote ? html`<p class="set-hint set-lang-note" data-testid="lang-mt-note">${mtNote}</p>` : null}
      <${Slider} label=${t('背景音乐')} micro="BGM" icon="play" value=${s.bgm} onInput=${(v) => updateSettings({ bgm: v })} />
      <${Slider} label=${t('干员语音')} micro="VOICE" icon="mic" value=${s.voice} onInput=${(v) => updateSettings({ voice: v })} />
      <${VoiceLangRow} value=${s.voiceLang} />
      <${Slider} label=${t('音效')} micro="SFX" icon="signal" value=${s.sfx}
                 onInput=${(v) => { updateSettings({ sfx: v }); if (!tested) { setTested(true); setTimeout(() => setTested(false), 400); audio.sfx('click'); } }} />
      <${Toggle} label=${t('静音')} micro="MUTE" value=${s.muted} onChange=${(v) => updateSettings({ muted: v })} />
      <${Toggle} label=${t('显示伤害数字')} micro="DAMAGE NUMBERS" value=${s.damageNumbers} onChange=${(v) => updateSettings({ damageNumbers: v })} />
      <${Toggle} label=${t('官方伤害数字')} micro="OFFICIAL NUMBERS" value=${s.officialDamageNumbers} onChange=${(v) => updateSettings({ officialDamageNumbers: v })} />
      <p class="set-hint">${t('只显示达到官方暴击条件的红色数字。关闭时仍显示每一次命中。')}</p>
      <${Toggle} label=${t('显示弹药与能量数量')} micro="AMMO & ENERGY" value=${s.ammoEnergyCount} onChange=${(v) => updateSettings({ ammoEnergyCount: v })} />
      <p class="set-hint">${t('弹药类技能开启时，在弹药条下方显示剩余弹药 / 总弹药数（如 13/14）；秘术师的血条下方显示储存的攻击能量 / 上限（如 2/3）。官方界面没有这些数字。')}</p>
      <p class="set-hint">${t('弹药类技能开启时，在弹药条下方显示剩余弹药 / 总弹药数（如 13/14）。官方界面没有这个数字。')}</p>
      <p class="set-hint">${t('在秘术师的血条下方显示储存的攻击能量 / 上限（如 2/3）。官方用干员身上的特效表示，没有这个数字。')}</p>
      <${Toggle} label=${t('作战统计')} micro="COMBAT STATS" value=${s.combatMetrics} onChange=${(v) => updateSettings({ combatMetrics: v })} />
      <p class="set-hint">${t('打开后，对局左下角可以查看自己干员的伤害、治疗和 DPS / HPS。官方界面没有这个窗口。改变玩法的插件对局在 Worker 里演算，统计不到，按钮不显示。')}</p>
      <${Toggle} label=${t('工坊外观')} micro="WORKSHOP SKINS" value=${s.workshopSkins} onChange=${(v) => updateSettings({ workshopSkins: v })} />
      <p class="set-hint">${t('工坊外观由已加载的包提供，缺哪一套时回落原版立绘。')}</p>
      <${Toggle} label=${t('工坊素材源')} micro="WORKSHOP LOAD SOURCES" value=${s.workshopSources} onChange=${(v) => updateSettings({ workshopSources: v })} />
      <p class="set-hint">${t('工坊素材源由已加载的包声明；关掉后一律从包内取。')}</p>
      <div class="set-row">
        <span class="set-row__label">${t('画面质量')}<${MicroLabel}>QUALITY<//></span>
        <div class="set-seg" role="radiogroup">
          ${QUALITY.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.quality === id ? 'true' : 'false'}
            class=${s.quality === id ? 'is-on' : ''} onClick=${() => updateSettings({ quality: id })}>${t(label)}</button>`)}
        </div>
      </div>
      ${fxOk ? html`<div class="set-row" data-testid="official-fx">
        <span class="set-row__label">${t('官方特效')}<${MicroLabel}>OFFICIAL FX<//></span>
        <div class="set-seg" role="radiogroup" aria-label=${t('官方特效')}>
          ${OFFICIAL_FX.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${fxTier === id ? 'true' : 'false'}
            class=${fxTier === id ? 'is-on' : ''} onClick=${() => updateSettings({ officialFx: id })}>${t(label)}</button>`)}
        </div>
      </div>
      <p class="set-hint">${t('使用服主从自己的游戏客户端提取的官方战斗特效（普攻、弹道、命中、状态、阵亡、部署，干员、召唤物和敌人的技能与天赋，以及秘术师储存的能量），连到这台服务器的玩家看到的都是服主提取的这一份；提取里没有的或对战中没有时机的（如只在游戏内部条件下触发的天赋效果）仍为本作的特效。精简：半分辨率贴图、粒子减半，适合手机。只在 3D 棋盘上显示。')}</p>` : null}
      <div class="set-row">
        <span class="set-row__label">${t('文字大小')}<${MicroLabel}>TEXT SIZE<//></span>
        <div class="set-seg set-textsize" role="radiogroup" aria-label=${t('文字大小')} data-testid="text-size">
          ${TEXT_SCALES.map(([id, label]) => html`<button key=${id} type="button" role="radio" aria-checked=${s.textSize === id ? 'true' : 'false'}
            class=${s.textSize === id ? 'is-on' : ''} onClick=${() => updateSettings({ textSize: id })}>${t(label)}</button>`)}
        </div>
      </div>
      <p class="set-hint set-textsize-note">${t('调整界面文字大小，棋盘保持原比例。')}</p>
      <${ScreenFitSection} />
      <${HotkeySection} keys=${s.keys} touchUi=${touchUi} />
      <${CosmeticSection} />
      <${DiagSection} />
      <p class="set-hint">${touchUi ? t('触屏操作：点击单位选中（撤退 / 出售）· 长按单位或卡牌查看详情 · 拖动部署后滑动选择朝向') : t('右键查看详情')}</p>
    </div>
  <//>`;
}

/**
 * The 设置 button of the lobby and the room (GitHub #238 — before it the settings were reachable only from the title
 * screen and a running match): the twin of the 玩法说明 button (ui/guide.js GuideButton), with the settings modal behind it
 * (mounted only while open). The same modal as the title screen's and the match's: nothing in it is match-only.
 * `square`: the gear alone (the lobby's top bar), the name stays title / aria-label — like GuideButton's.
 * @param {{ class?: string, size?: 'sm'|'md'|'lg'|'xl', variant?: string, label?: string, square?: boolean }} props
 */
export function SettingsButton({ class: cls, size = 'sm', variant = 'ghost', label = t('设置'), square = false }) {
  const [open, setOpen] = useState(false);
  return html`<${Button} variant=${variant} size=${size} square=${square} class=${cx('settings-btn', cls)} onClick=${() => setOpen(true)}
      title=${t('设置')} aria-label=${t('设置')} data-testid="settings-btn"><${GIcon} name="gear" class="btn__icon" />${square ? null : label}<//>
    ${open ? html`<${SettingsModal} open=${true} onClose=${() => setOpen(false)} />` : null}`;
}
