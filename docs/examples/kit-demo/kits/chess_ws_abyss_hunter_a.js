// 行为层示例 kit —— workshop/<pack>/kits/<chessId>.js（docs/WORKSHOP.md §4）
//
// 这是**包的 JavaScript**，不是数据。默认导出就是模拟器调用的 kit 函数：
//
//     (bb, chess, def) => Kit
//
// 契约与官方内容 server/sim/content/kits/tierN.js 完全一致，所以工坊能做官方能做的一切：
// 通过 `battle.on(...)` 钩子总线、`battle.addBuff / dealDamage / spawnToken …` 等引擎辅助方法实现任意机制。
//
// 三条必须知道的规则（都是从源码里确认的，不是猜测）：
//
//  1. **kit 一旦返回，技能就归它管**。Battle 用 `u.kit.skill || null` 取技能：返回了 kit 却没给 `skill`，
//     这名干员就**没有技能**（缺省技能不会自动回退到通用 kit）。所以要么显式给出 skill，要么就不要返回 kit。
//  2. **必须自包含，不能 import 引擎模块**。同一份文件会被两种方式加载：
//       服务端  按真实路径 import  → 相对路径 `../../sim/...` 指向 workshop/ 下面，是错的
//       浏览器  按 URL import      → `/sim/...` 能解析，但服务端解析不了
//     两者无法同时成立，所以只能只用传进来的 `battle` 与参数。
//  3. **它会在玩家浏览器里执行**（默认 SP_COMBAT=client），服务端再用同一份文件复算。
//     所以不要写依赖环境的代码（时间、随机源请用 `battle.rng`、DOM、网络一律不要）。

export default function kit(bb, chess, def) {
  return {
    // ---- 1) 技能：本包的干员是「8 发弹药、攻击力 +60%、攻速 +40」的射手
    //        这里显式写出等价的 SkillSpec（kind/ammo/mods/attack 见 docs/DESIGN.md §5.6）
    skill: {
      kind: 'ammo',
      ammo: nb(bb.trigger_time, 8),
      mods: { atkPct: nb(bb.atk, 0), aspd: nb(bb.attack_speed, 0) },
      attack: { atkScale: nb(bb.atk_scale, 1) },
    },

    // ---- 2) 天赋：这才是黑板书（bb）表达不了、必须写代码的部分 —— 常驻 +25% 攻击力
    //        注意与 bb.atk 的区别：bb.atk 只在技能期间生效，这个天赋是永久的。
    talents: [
      {
        name: '深渊直觉',
        description: '部署后攻击力永久 +25%',
        install(battle, unit) {
          // addBuff 是引擎公开的辅助方法之一（docs/DESIGN.md §5.3–§5.4 的 Engine helpers）
          battle.addBuff(unit, {
            key: 'wsdemo:resolve',         // 唯一 key：同名 buff 会被替换而不是叠加
            source: 'workshop:kit-demo',   // 便于在排查时看出效果来自哪个包
            duration: Infinity,            // 永久
            mods: { atkPct: 0.25 },        // 与技能/盟约的百分比同一个加算桶（DESIGN §5.2）
            tags: ['workshop'],
          });
        },
      },
    ],
  };
}

/** 取一个有限数字，否则用默认值（bb 里可能缺键）。 */
function nb(v, d) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
