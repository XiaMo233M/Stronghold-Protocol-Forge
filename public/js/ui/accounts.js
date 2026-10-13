// Compat shim (stronghold-ui-hub package) — install ONLY when the target has no public/js/ui/accounts.js.
// The hub and the room were written for a deployment with player accounts (avatar, #tag). Without accounts: the top-bar
// chip shows the player's name and opens 统计数据 (what the original lobby's name chip did), seats show no #tag.
import { html, AvatarFrame, MicroLabel } from './components.js';
// 本仓库的 i18n 纪律：界面上的中文一律走 t()（compat 垫片也不例外 —— test/i18n.test.js 扫 public/js 全量）。
import { t } from '../../../shared/i18n.js';

/** The hub's top-right chip: avatar initial + name; a click opens 统计数据. */
export function AccountMeChip({ player, onStats }) {
  const name = player?.name || t('博士');
  return html`<button type="button" class="me-chip me-chip--btn stats-entry" onClick=${onStats} title=${t('统计数据')} aria-label=${t('统计数据')}>
    <${AvatarFrame} size="sm" name=${name} seat=${0} self=${true} />
    <span class="me-chip__text"><span class="me-chip__name">${name}</span><${MicroLabel}>STATS<//></span>
  </button>`;
}

/** No account data: a seat's account (avatar, #tag) is unknown. */
export function useAccount() { return null; }

/** No account data: no #tag. */
export function AccountTag() { return null; }
