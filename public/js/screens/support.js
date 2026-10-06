// 助战 (support picker): choose which support operators to bring, before a match.
//
// The twin of 干员调配 (screens/loadout.js), with the same shell (an overlay opened from the lobby, the room and the
// briefing; <SupportHost/> mounted once by main.js) — but two rules differ, and they shape this file:
//
//   1. **The pool is declared and enforced by the SERVER** (`data/support.json`, docs/WORKSHOP.md). The screen can only
//      offer what `room.state.support` lists: an operator the pool does not name is DISABLED, so the picker must not be
//      able to show it. Until the server has sent its catalog the screen says so instead of guessing.
//   2. **A selection is never silently defaulted.** The loadout falls back to defaults when the server refuses; a
//      support selection must not, because the fallback could be a DIFFERENT operator than the player chose — exactly
//      what 「没有即禁用」 forbids. A refusal is reported and the player's choice is kept for them to fix.
//
// State + server sync live in ui/supportSync.js; the pure selection rules in ui/supportModel.js.

import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel, Button, TierChip } from '../ui/components.js';
import { Img } from '../ui/gameComponents.js';
import { chessAvatarUrl, profIconUrl } from '../ui/assetUrls.js';
import { data, useData } from '../data.js';
import { useStore } from '../store.js';
import { PHASE } from '../../../shared/constants.js';
import {
  tierUsage, toggleSupport, usageLine, sanitizeSupport, SUPPORT_PREF,
} from '../ui/supportModel.js';
import { supportStore, openSupport, closeSupport, setSupportEntries, clearSupport } from '../ui/supportSync.js';

export { openSupport, closeSupport };

/** The sync states the top bar explains (ui/supportSync.js sets them). */
const SYNC_TEXT = {
  idle: '离线：连上服务器后会自动提交',
  waiting: '等待服务器下发助战卡池…',
  pending: '待提交…',
  sending: '提交中…',
  synced: '已提交',
  locked: '本局已锁定，改动下一局生效',
  error: '服务器拒绝了这次选择（已保留你的选择）',
};

/** Whether the overlay must close by itself (a match left the briefing, or one started). */
export function shouldAutoClose(st, phase, inMatch, wasInMatch) {
  if (!st || !st.open) return false;
  if (st.from === 'briefing') return !!phase && phase !== PHASE.INFO_CHECK;
  return inMatch && !wasInMatch;
}

/** One operator row: avatar, name, profession/tier, and whether it is currently picked. */
function SupportRow({ id, picked, full, onToggle }) {
  const rec = data.lookup('chess', id);
  const m = data.get('assets');
  const name = rec?.name || id;
  const prof = rec?.profession || null;
  const disabled = !picked && full;
  return html`<button type="button" class=${`sp-row${picked ? ' on' : ''}${disabled ? ' full' : ''}`}
      data-testid=${`support-${id}`} disabled=${disabled}
      title=${disabled ? '该阶助战名额已满' : (picked ? '点击移出本次助战' : '点击加入本次助战')}
      onClick=${() => onToggle(id)}>
    <${Img} src=${chessAvatarUrl(m, rec)} class="sp-row__img" fallback=${html`<span class="sp-row__ph">${name.slice(0, 1)}</span>`} />
    <span class="sp-row__txt">
      <span class="sp-row__name">${name}</span>
      <span class="sp-row__meta">
        ${prof ? html`<${Img} src=${profIconUrl(m, prof)} class="sp-row__prof" fallback=${null} />` : null}
        <span class="dim">${rec?.tier ? `${rec.tier} 阶` : ''}${rec?.subProfessionName ? ` · ${rec.subProfessionName}` : ''}</span>
      </span>
    </span>
    <span class="sp-row__mark">${picked ? '已选' : (disabled ? '名额已满' : '')}</span>
  </button>`;
}

function SupportScreen({ st }) {
  useData('chess', 'assets'); // names / professions / tiers for the pool (the pool itself comes from the server)
  const catalog = st.catalog;
  const entries = st.entries;
  const ready = data.status('chess') === 'ready';
  if (!ready) {
    return html`<div class="sp-overlay"><div class="sp-panel"><div class="sp-loading">正在载入干员数据…</div></div></div>`;
  }
  if (!catalog) {
    return html`<div class="sp-overlay" data-testid="support-overlay">
      <div class="sp-panel">
        <div class="sp-head">
          <${MicroLabel}>助战<//>
          <span class="sp-head__spacer"></span>
          <${Button} variant="ghost" size="sm" onClick=${closeSupport}>关闭<//>
        </div>
        <p class="hint" data-testid="support-waiting">
          这个服务器还没有下发助战卡池。助战卡池由服务端声明，客户端不会自行猜测 ——
          进入房间后（或服务器尚未开启助战时）这里会保持为空。
        </p>
      </div>
    </div>`;
  }
  if (!catalog.enabled) {
    return html`<div class="sp-overlay" data-testid="support-overlay">
      <div class="sp-panel">
        <div class="sp-head">
          <${MicroLabel}>助战<//>
          <span class="sp-head__spacer"></span>
          <${Button} variant="ghost" size="sm" onClick=${closeSupport}>关闭<//>
        </div>
        <p class="hint" data-testid="support-disabled">本服务器未开启助战。</p>
      </div>
    </div>`;
  }
  const usage = tierUsage(catalog, entries);
  const onToggle = (id) => {
    const r = toggleSupport(catalog, entries, id);
    if (r.full) return;           // the row is disabled anyway; this is the belt-and-braces path
    if (r.changed) setSupportEntries(r.entries);
  };
  return html`<div class="sp-overlay" data-testid="support-overlay">
    <div class="sp-panel">
      <div class="sp-head">
        <${MicroLabel}>${catalog.label || '助战'}<//>
        <span class="sp-head__spacer"></span>
        <span class="sp-usage" data-testid="support-usage">${usageLine(catalog, entries)}</span>
        <span class=${`sp-sync sp-sync--${st.sync}`} data-testid="support-sync">${SYNC_TEXT[st.sync] || st.sync}</span>
        <${Button} variant="ghost" size="sm" disabled=${!entries.length} onClick=${() => clearSupport()}>清空<//>
        <${Button} variant="ghost" size="sm" onClick=${closeSupport}>关闭<//>
      </div>
      <p class="hint">
        每阶可以带的名额由服务器控制；卡池之外的干员不会出现在这里，也不会被服务器接受。
        带上的干员会进你的商店：像普通棋子一样摇得到、按阶级价买到、卖掉也按普通规则结算
        （服务端可以在 data/support.json 的 prices 里给它单独定价）。本局的助战在开局后锁定，改动在下一局生效。
      </p>
      ${usage.map((u) => html`
        <div class="sp-tier" key=${u.tier}>
          <div class="sp-tier__head">
            <${TierChip} tier=${u.tier} />
            <span class="sp-tier__n" data-testid=${`support-count-${u.tier}`}>已选 ${u.used}/${u.slots}</span>
          </div>
          <div class="sp-grid">
            ${u.ids.map((id) => html`<${SupportRow} key=${id} id=${id} picked=${entries.includes(id)} full=${u.full} onToggle=${onToggle} />`)}
          </div>
        </div>`)}
    </div>
  </div>`;
}

/** Mounted once (main.js): renders the overlay while open. */
export function SupportHost() {
  const st = useStore((s) => s, Object.is, supportStore);
  const phase = useStore((s) => s.match?.public?.phase || null);
  const inMatch = useStore((s) => !!s.room?.inMatch);
  const wasInMatch = useRef(inMatch);
  useEffect(() => {
    if (shouldAutoClose(st, phase, inMatch, wasInMatch.current)) closeSupport();
    wasInMatch.current = inMatch;
  }, [phase, inMatch, st.open]);
  if (!st.open) return null;
  return html`<${SupportScreen} st=${st} />`;
}

/**
 * Entry button (lobby / room / briefing). The badge is how many supports are selected.
 * @param {{ from: 'lobby'|'room'|'briefing', size?: string, variant?: string, class?: string, label?: string }} props
 */
export function SupportButton({ from, size = 'md', variant = 'secondary', class: cls, label = '助战' }) {
  useData('chess', 'assets');
  const entries = useStore((s) => s.entries, Object.is, supportStore);
  const catalog = useStore((s) => s.catalog, Object.is, supportStore);
  // a selection the current pool no longer allows must not be counted (supportModel.sanitizeSupport drops it)
  const n = catalog ? sanitizeSupport(catalog, entries).entries.length : 0;
  const disabled = catalog ? !catalog.enabled : false;
  return html`<button type="button" class=${`btn btn--${variant} btn--${size} sp-entry ${cls || ''}`}
      data-testid="support-open" disabled=${disabled}
      title=${catalog ? (catalog.enabled ? '选择本次携带的助战干员' : '本服务器未开启助战') : '助战卡池由服务端下发'}
      onClick=${() => openSupport(from)}>
    <${Icon} name="users" class="btn__icon" />
    <span class="btn__label">${label}</span>
    ${n ? html`<span class="sp-entry__n num" aria-label=${`已选 ${n} 名助战`}>${n}</span>` : null}
  </button>`;
}
