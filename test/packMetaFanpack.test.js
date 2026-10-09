// test/packMetaFanpack.test.js — fanpack 的「准备阶段那一半」逐句移植的**端到端验收**（DESIGN §29）。
//
// 被移的是 `E:\destop\卫戍协议罗德岛卡兹戴尔盟约mod` 里 `server/sim/content/bonds/custom.js` 的 **prep side**
//（原文件 291-330 行）：按层里程碑的步长发奖、用玩家级计数器保证「一步只发一次」、发一条提示 —— 那 40 行是那个包
// 需要引擎提供的**全部**东西的清单。移植时**唯一**的改动是引擎辅助函数（`num` / `bondRecord` / `buffParams`）从
// `registry.api` 拿而不是 `import`：Node 没有 import map，而把引擎路径写进包等于把「包在哪个目录」写进内容。
//
// 两处**故意的替换**，都必须说清楚：
//   * 盟约挂**官方**的 `victoriaShip`（不是 mod 的 `kazdelShip`）：社区 mod 的内容与代码按业主裁决**不进这个仓库**
//     （永不进发行版），而 `victoriaShip` 用的黑板书键 `bond_layer_added_reward_equip` 与层里程碑形状，正是那份
//     mod 抄的模式（原文件头注：「the 维多利亚 hammer-milestone pattern」）；
//   * 所以奖品 id 用一件官方装备，「三个维多利亚成员才激活」那条前置条件也不在 fixture 里（否则测试得先摆三位
//     维多利亚干员）—— 被验的不是那个条件，而是**引擎给包的这套 API 够不够它把这段逻辑写出来**。
//
// Run: node --test test/packMetaFanpack.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadWorkshop } from '../server/workshop.js';
import { loadMetaModules, buildRoomRegistry } from '../server/match/metaPack.js';
import { resetDefaultRegistry } from '../server/match/effectsMeta.js';
import { makeMatch } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const BOND = 'victoriaShip';
const REWARD = 'chess_item_1_01_e_a';
const TOAST = '【维多利亚】获得';

/**
 * 逐句移植自 `bonds/custom.js` 的 `payKazdelReward`（只有变量名与「怎么拿到引擎助手」两处不同）：
 *   * 黑板书用 `buffParams(record, 'bond_layer_added_reward_equip')` 读，步长与件数都从那里来（**不写字面量** ——
 *     原文件头注对这件事说得很重：数值只从 `bb` 读）；
 *   * `due = floor(layers / step)` 是「到这一步了没有」，玩家级计数器保证**一步只发一次**（`ctx.counter` /
 *     `ctx.setCounter`）—— 少了它，每个 hook 都发一遍，同一层会被反复结账；
 *   * `ctx.grantItem` 的返回值是「真的发到手了」，不是「调用过了」（背包满/道具销毁时它回 null）。
 */
const PORTED_PREP_HALF = `
export function registerMeta(registry) {
  const { num, bondRecord, buffParams } = registry.api;
  const BOND = ${JSON.stringify(BOND)};
  const REWARD = ${JSON.stringify(REWARD)};
  const COUNTER = 'bondcustom:victoria:paid';

  function pay(ctx) {
    const p = buffParams(ctx.data?.bonds?.[BOND] ?? bondRecord(BOND), 'bond_layer_added_reward_equip');
    const step = Math.floor(num(p?.layer, 0));
    if (!(step > 0)) return 0;
    const due = Math.floor(ctx.layers(BOND) / step);
    const count = Math.max(1, Math.floor(num(p.count, 1)));
    let granted = 0;
    for (let guard = 0; guard < 100; guard++) {
      const paid = ctx.counter(COUNTER);
      if (paid >= due) break;
      ctx.setCounter(COUNTER, paid + 1);
      for (let i = 0; i < count; i++) {
        if (ctx.grantItem(REWARD, { source: 'bond:' + BOND })) granted++;
      }
    }
    if (granted && typeof ctx.toast === 'function') ctx.toast(${JSON.stringify(TOAST)} + granted + '件维式重锤', 'info');
    return granted;
  }

  // 原文件的那张钩子表：层数变化的当口，以及每一个「回合/准备阶段推进」的当口都结一次账。
  const handler = {};
  for (const hook of ['onLayers', 'onRoundStart', 'onPrepStart', 'onPrepEnd', 'onBuy', 'onGain', 'onSold', 'onMerge']) {
    handler[hook] = function (ctx, ev) {
      if (hook === 'onLayers' && !(ev && ev.bondId === BOND)) return;
      pay(ctx);
    };
  }
  registry.global('victoriaLayerReward', handler);
}
`;

describe('fanpack 的准备阶段逻辑：以包声明的 meta 模块跑起来', () => {
  let tmp;
  let wsRoot;

  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-fanmeta-'));
    wsRoot = path.join(tmp, 'ws');
    const dir = path.join(wsRoot, 'fanpack-prep');
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'fanpack-prep', name: 'fanpack prep half', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', combat: true,
      server: { meta: { module: 'meta/bonds.mjs', registers: ['global:victoriaLayerReward'] } },
    }));
    fs.writeFileSync(path.join(dir, 'meta', 'bonds.mjs'), PORTED_PREP_HALF);
  });
  after(() => {
    resetDefaultRegistry();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** 装一次包，拿到这一局的注册表。 */
  async function roomRegistry() {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.deepEqual(loaded.errors, []);
    const { modules, errors } = await loadMetaModules(loaded, { log: quiet });
    assert.deepEqual(errors, [], '这段移植必须能过静态确定性扫描');
    const { registry, errors: buildErrors } = buildRoomRegistry({ packs: modules, log: quiet });
    assert.deepEqual(buildErrors, []);
    return registry;
  }

  test('25 层 → 发一件，提示一次；计数器保证一步只结一次账', async () => {
    const registry = await roomRegistry();
    const h = makeMatch({ mode: 'solo', registry }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');

    // 步长 25（官方黑板的 bb.layer）、每步 1 件（bb.count）：把层数推到 25 再推进一个准备阶段。
    ps.addLayers(BOND, 25, { requireActive: false });
    h.toPrep(2);

    const toasts = h.sent.filter(([, msg]) => msg.t === 'm.toast').map(([, msg]) => msg.text);
    assert.ok(toasts.some((x) => typeof x === 'string' && x.startsWith(TOAST)), `应当有结账提示，实际：${JSON.stringify(toasts)}`);
    assert.equal(ps.counters['bondcustom:victoria:paid'], 1, '一步只发一次');
    const owned = [...(ps.hand || []), ...(ps.temp || [])].filter(Boolean).map((p) => p.id);
    assert.ok(owned.includes(REWARD), `奖品应当真的到手：${JSON.stringify(owned)}`);
    assert.deepEqual(h.logs.error, []);
  });

  test('同一层数再推进：不重复结账（计数器是玩家级的）', async () => {
    const registry = await roomRegistry();
    const h = makeMatch({ mode: 'solo', registry }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.addLayers(BOND, 25, { requireActive: false });
    h.toPrep(2);
    h.toPrep(3);
    assert.equal(ps.counters['bondcustom:victoria:paid'], 1, '层数没涨，账不该再结一次');
  });

  test('到 75 层：补发剩下的两步（3 件）', async () => {
    const registry = await roomRegistry();
    const h = makeMatch({ mode: 'solo', registry }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.addLayers(BOND, 75, { requireActive: false });
    h.toPrep(2);
    assert.equal(ps.counters['bondcustom:victoria:paid'], 3, '75 / 25 = 3 步');
  });

  test('层数不够一步：什么都不发（也不留计数器）', async () => {
    const registry = await roomRegistry();
    const h = makeMatch({ mode: 'solo', registry }).start();
    h.toPrep(1);
    const ps = h.ps('p_0');
    ps.addLayers(BOND, 24, { requireActive: false });
    h.toPrep(2);
    assert.equal(ps.counters['bondcustom:victoria:paid'], undefined);
  });
});
