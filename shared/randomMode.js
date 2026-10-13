// Compat shim (stronghold-ui-hub package) — install ONLY when the target has no shared/randomMode.js, and copy it to
// public/shared/randomMode.js as well (the browser's /shared/ is that mirror in some setups).
// 无限火力 (a random mode of the original deployment) needs server support (room.setRandom). Without it the hub hides
// the 无限火力 entry by itself (lobby.js CAN_FIREPOWER); these values only let the module load — they are never shown.
// `N_()` 是本仓库给**模块级**文案的标记（与 shared/constants.js 同一条规矩）：显示处再调 t()。
import { N_ } from './i18n.js';
export const RANDOM_MODE = Object.freeze({
  totalRounds: 0,
  endurance: Object.freeze({ totalRounds: 0, leaders: [] }),
  marathon: Object.freeze({ totalRounds: 0, leaders: [] }),
  rounds: Object.freeze({ leaders: [] }),
  unsupported: true,
});
export const RANDOM_MODE_NAME = N_('无限火力');
