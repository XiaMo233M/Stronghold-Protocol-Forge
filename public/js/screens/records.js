// 上局战绩（docs/RECORDS.md §4）。
//
// 两个来源，顺序固定：
//   1. **服务端**（可选）：`records.mine` → `records.latest`，答案按可见档位裁剪 —— 界面上只有 `seat` 与
//      「是不是你」，因为公开档就是那样（业主裁令）。它在**服务端开着账号**时才有意义：换台机器、换个浏览器，
//      同一份战绩还在。
//   2. **本机**（永远有）：`public/js/ui/stats.js` 的 `loadStats()` 里最近一条记录。本机战绩**不是本文件
//      的职责** —— 它已经有一套完整的落盘、迁移、压缩预算（`ui/stats.js`），这里只是**读**它。所以本文件不写
//      localStorage、不另起一个 key，也不重复 `recordResult` 的活。
//
// 「什么时候**没有**服务端战绩」是正常状态而不是错误：没开账号的服务器、离线、还没打完一局。三种都落到本机那
// 一份；本机也没有就说「暂无完整对局战绩」。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Modal } from '../ui/components.js';
import { loadStats } from '../ui/stats.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

/**
 * 本机最近一条已结算记录（`ui/stats.js` 的形状）。
 *
 * 中途退出的记录（`end !== 'settled'`）**不算**「上局战绩」：它没有结算可看，与服务端「只落完整结算」是同一条
 * 口径。顺序不假设（`ui/stats.js` 决定怎么排），直接取 `t` 最大的那条。
 * @returns {object|null}
 */
export function lastLocalRecord() {
  try {
    const { records } = loadStats();
    if (!Array.isArray(records)) return null;
    let best = null;
    for (const record of records) {
      if (!record || record.end !== 'settled') continue;
      if (!best || Number(record.t) > Number(best.t)) best = record;
    }
    return best;
  } catch { return null; }
}

/**
 * 本机记录 → 与服务端 `records.latest` 同形的展示对象，界面因此只有一条渲染路径。
 *
 * 两处刻意与公开档不同，因为**这份数据本来就在本机**（是这台浏览器自己记的，不是服务端公开的）：
 *   * 昵称照显示（服务端公开档对陌生人只给座位号，那是**服务端**的裁剪，不是本机数据的属性）；
 *   * `damageSharePct` 在这里现算 —— 服务端在结算摘要里给这个数，本机记录里没有。
 * 购卡明细两处都没有：`ui/stats.js` 的压缩帧不存它（那是它的取舍），所以这里如实说「不显示」。
 */
function fromLocal(record) {
  if (!record || !Array.isArray(record.players) || !record.players.length) return null;
  const totalDamage = record.players.reduce((sum, player) => sum + Math.max(0, Number(player.stats?.dmgDealt) || 0), 0);
  const selfRow = record.players.find((player) => player.playerId === record.selfId) || null;
  return {
    source: 'local',
    code: null,
    finishedAt: Number(record.t) || null,
    victory: !!record.victory,
    roundsPassed: Number(record.roundsPassed) || 0,
    ownSeat: selfRow ? Number(selfRow.seat) || 0 : null,
    players: record.players.map((player) => ({
      seat: Number(player.seat) || 0,
      name: player.name || t('博士'),
      isBot: !!player.isBot,
      victory: !!record.victory,
      roundsPassed: Number(player.roundsPassed) || Number(record.roundsPassed) || 0,
      damageSharePct: totalDamage
        ? Math.round(Math.max(0, Number(player.stats?.dmgDealt) || 0) / totalDamage * 1000) / 10
        : 0,
      stats: player.stats && typeof player.stats === 'object' ? player.stats : {},
      bonds: Array.isArray(player.bonds) ? player.bonds : [],
      purchases: null,
    })),
  };
}

const fmt = (value) => Math.round(Number(value) || 0).toLocaleString();

const STAT_ROWS = [
  ['dmgDealt', () => t('造成伤害')],
  ['damageSharePct', () => t('输出占比')],
  ['bossDamage', () => t('领袖伤害')],
  ['activatedLayers', () => t('盟约层数')],
  ['buys', () => t('买卡次数')],
  ['refreshes', () => t('刷新次数')],
  ['merges', () => t('晋升次数')],
  ['itemsEquipped', () => t('配发装备')],
  ['gold', () => t('消耗资金')],
];

function statValue(player, key) {
  if (key === 'damageSharePct') return `${Math.round(Number(player.damageSharePct ?? player.stats?.damageSharePct) || 0)}%`;
  const raw = key === 'buys'
    ? player.stats?.buys ?? (Array.isArray(player.purchases) ? player.purchases.reduce((sum, p) => sum + (Number(p.count) || 0), 0) : 0)
    : player.stats?.[key];
  return fmt(raw);
}

/** 一名玩家的战绩块。`own` = 请求者自己（高亮）。 */
function PlayerStats({ player, own }) {
  const bonds = (Array.isArray(player.bonds) ? player.bonds : []).filter((bond) => bond.layers > 0 || bond.active);
  const purchases = Array.isArray(player.purchases) ? player.purchases : null;
  const hasStats = STAT_ROWS.some(([key]) => player.stats?.[key] != null || (key === 'damageSharePct' && player.damageSharePct != null));
  return html`<section class=${`match-record__player${own ? ' is-own' : ''}`}>
    <h3>${player.name}${player.isBot ? ' · AI' : ''}${own ? ` · ${t('你')}` : ''}</h3>
    ${hasStats
      ? html`<div class="match-record__stats">
          ${STAT_ROWS.map(([key, label]) => html`<div key=${key}><span>${label()}</span>
            <b class="num">${statValue(player, key)}</b></div>`)}
        </div>`
      : null}
    <div class="match-record__details">
      <div>
        <h4>${t('盟约层数')}</h4>
        ${bonds.length
          ? bonds.map((bond) => html`<div class="match-record__entry" key=${bond.bondId}>
              <span>${bond.name || bond.bondId}</span><b class="num">${bond.layers} ${t('层')}</b></div>`)
          : html`<p>—</p>`}
      </div>
      <div>
        <h4>${t('购入卡牌')}</h4>
        ${purchases
          ? (purchases.length
            ? purchases.map((purchase) => html`<div class="match-record__entry" key=${`${purchase.kind}:${purchase.id}`}>
                <span>${purchase.name || purchase.id}<small>${purchase.kind === 'item' ? t('装备') : t('干员')}</small></span>
                <b class="num">×${purchase.count} · ${purchase.spent || 0} ${t('资金')}</b></div>`)
            : html`<p>—</p>`)
          : html`<p class="match-record__muted">${t('这里不显示购卡明细')}</p>`}
      </div>
    </div>
  </section>`;
}

/** 一条记录的整体（总览 + 每人明细）。 */
function RecordBody({ record }) {
  return html`<div class="match-record__body">
    <p class="match-record__meta">
      ${record.victory ? t('模拟完成') : t('模拟失败')}
      · ${t('通过回合')} ${record.roundsPassed || 0}
      ${record.code ? ` · ${record.code}` : ''}
      ${Number.isFinite(record.finishedAt) && record.finishedAt ? ` · ${new Date(record.finishedAt).toLocaleString()}` : ''}
    </p>
    ${record.players.map((player) => html`<${PlayerStats} key=${player.seat}
      player=${player} own=${record.ownSeat != null && player.seat === record.ownSeat} />`)}
  </div>`;
}

/**
 * 「上局战绩」按钮 + 弹窗。
 *
 * 只有一条取数路径：`records.mine`（本人那一档，带昵称与购卡明细）。房间的**公开**档（只给座位号）走
 * `GET /api/records/<CODE>`，那是给「知道房间号的人」用的只读接口，不是这个按钮要的东西 —— 同房队友的明细本来
 * 就不该在这里出现（业主裁令）。
 */
export function MatchRecordsButton({ class: cls }) {
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setLoading(true);
    setRecord(null);
    // 先挂监听再发请求：`records.mine` 的回执是一条**推送**，不是一个带 rid 的应答。
    const stop = net.on('records.latest', (message) => {
      if (!active) return;
      // 服务端说「没有」时落到本机那一份 —— 「这个账号还没打完一局」不该让界面空着。
      setRecord(message.record || fromLocal(lastLocalRecord()));
      setLoading(false);
    });
    // 离线 / 服务端没开账号 / 请求失败：直接给本机那一份，不要空着等超时。
    net.request('records.mine').catch(() => {
      if (active) { setRecord(fromLocal(lastLocalRecord())); setLoading(false); }
    });
    return () => { active = false; stop(); };
  }, [open]);

  return html`<${Button} variant="secondary" size="sm" icon="chart" class=${cls} onClick=${() => setOpen(true)}>
      ${t('上局战绩')}<//>
    <${Modal} open=${open} title=${t('上局战绩')} micro="ALLIANCE REPORT" tone="mint" onClose=${() => setOpen(false)}>
      ${loading
        ? html`<p>${t('读取中…')}</p>`
        : record
          ? html`<${RecordBody} record=${record} />`
          : html`<p>${t('暂无完整对局战绩')}</p>`}
    <//>`;
}
