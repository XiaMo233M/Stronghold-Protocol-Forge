// editor/ui/waveHints.js — 出怪页的两处「把话说清楚」的纯逻辑。
//
// 一、**阵营占位符**：官方敌人里有 8 个键是阵营随机生成的占位符（`factions.templateSlots`）。选了它们，
//     实际出的是阵营随机怪、数量按战力重算；如果抽到的怪与它移动方式不同，这一次**一只都不出**
//     （server/match/waves.js 里 `valid:false` 那条分支），而校验器一个字都不说。所以界面要标出来。
//
// 二、**这张表到底在哪生效**：出怪页那个「绑定到回合」只写 `usedBy`，引擎从来不读；真正生效的是**地图自己的
//     `rounds`/`bossRounds`**（引擎先看这张图、再看模式的模板）。地图页现在能编辑它们了，这里就把
//     「哪张图的哪几个回合真的用了这张表」算出来，让作者不必靠记忆对齐两边。

import { boundWaveOf } from './stageRounds.js';

/** 这个敌人键是不是阵营占位符。 */
export function isPlaceholderEnemy(key, placeholderEnemies) {
  return !!placeholderEnemies && typeof key === 'string' && Object.prototype.hasOwnProperty.call(placeholderEnemies, key);
}

/** 占位符的槽位（`N`/`E`/`S` 及带 `F` 的飞行版），不是占位符就返回 null。 */
export function placeholderSlotOf(key, placeholderEnemies) {
  if (!isPlaceholderEnemy(key, placeholderEnemies)) return null;
  const v = placeholderEnemies[key];
  if (typeof v === 'string' && v) return v;
  if (v && typeof v.slot === 'string' && v.slot) return v.slot;
  return '?';
}

/** 这张出怪表里用到的占位符键（去重、排序），界面据此提示一次。 */
export function placeholderSpawns(spawns, placeholderEnemies) {
  const keys = new Set();
  for (const sp of Array.isArray(spawns) ? spawns : []) {
    if (isPlaceholderEnemy(sp?.key, placeholderEnemies)) keys.add(sp.key);
  }
  return [...keys].sort();
}

/**
 * 哪些地图真的把这张表绑到了哪几个回合。
 * @param {string} waveId
 * @param {Array<{id:string,name?:string,official?:boolean,pack?:string,rounds?:object,bossRounds?:object}>} stages 服务端 stageChoices()
 * @returns {Array<{id:string,name:string,official:boolean,pack:string|null,rounds:number[],bossRounds:number[]}>}
 */
export function mapsUsingWave(waveId, stages) {
  if (typeof waveId !== 'string' || !waveId) return [];
  const out = [];
  for (const s of Array.isArray(stages) ? stages : []) {
    if (!s || typeof s.id !== 'string') continue;
    const rounds = [];
    const bossRounds = [];
    for (const [k, v] of Object.entries(s.rounds ?? {})) if (boundWaveOf(v) === waveId) rounds.push(Number(k));
    for (const [k, v] of Object.entries(s.bossRounds ?? {})) {
      if (v && typeof v === 'object' && Object.values(v).some((x) => x === waveId)) bossRounds.push(Number(k));
    }
    if (rounds.length || bossRounds.length) {
      out.push({
        id: s.id, name: s.name ?? s.id, official: s.official === true, pack: s.pack ?? null,
        rounds: rounds.sort((a, b) => a - b), bossRounds: bossRounds.sort((a, b) => a - b),
      });
    }
  }
  // 工坊自己的图排前面（那才是作者要找的），同组按 id
  return out.sort((a, b) => (Number(a.official) - Number(b.official)) || a.id.localeCompare(b.id));
}
