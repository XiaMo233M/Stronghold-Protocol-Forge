// test/kitPrompt.test.js — docs/prompts/kit.md 里那份示例 kit 必须**真的能跑**。
//
// 文档里的代码块最容易腐烂：API 改名、钩子词表变动、`addBuff` 的叠加语义改了 —— 而创作者是照着这份文档写第一份
// kit 的，文档错一步他就得到一份「加载成功、什么都不做」的文件。所以这里把示例从 markdown 里抽出来：
//   ① 走 shared/kitAuthoring.js 的静态校验（默认导出 / 零 import / 钩子名）；
//   ② 注入一场真实战斗跑一遍：技能真的激活 → 真的击杀 → buff 真的按层叠加 → 技能结束真的清空。
// 改文档里的示例时，这条测试会跟着一起断言，改不动就是文档写错了。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateKit, HOOK_EVENTS } from '../shared/kitAuthoring.js';
import { makeBattle, chessRec, enemyRec, checkInvariants } from './helpers/battleHarness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(join(ROOT, 'docs/prompts/kit.md'), 'utf8');

/** 取文档里那个完整示例 kit（第二节的表头注释是它的标记；上面还有一段带省略号的骨架，不是可运行的代码）。 */
function exampleSource() {
  const blocks = [...DOC.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes('// kits/chess_ws_tide_hunter_a.js'));
  assert.equal(found.length, 1, 'docs/prompts/kit.md 里应当恰好有一个完整示例 kit（以 `// kits/chess_ws_tide_hunter_a.js` 开头）');
  return found[0];
}

const ID = 'chess_ws_tide_hunter_a';
const SRC = exampleSource();

/** 从源码字符串加载模块（data: URL，不落盘、不进仓库）。 */
async function loadKit(source) {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const mod = await import(url);
  return mod.default;
}

describe('行为层 prompt（docs/prompts/kit.md）', () => {
  test('示例 kit 通过静态校验：有默认导出、零 import、钩子名都在词表里', () => {
    assert.deepEqual(validateKit(SRC, { id: ID, ownChessIds: [ID] }), []);
  });

  test('示例 kit 真的被引擎用上：skill spec 来自 kit，bb 读得到', async () => {
    const kitFn = await loadKit(SRC);
    const h = makeBattle({
      defs: { chess: { [ID]: chessRec({ id: ID, baseId: ID, skill: { bb: { trigger_time: 5, atk: 0.5, atk_scale: 1.4 }, spCost: 5, initSp: 5 } }) }, enemies: { enemy_test: enemyRec({ key: 'enemy_test', hp: 5000 }) } },
      units: [{ chessId: ID, row: 10, col: 4, uid: 1 }],
      enemies: [{ key: 'enemy_test', hp: 5000, time: 0 }],
      kits: { [ID]: kitFn },
      autoFinish: false,
      timeLimit: 60,
    });
    h.step();
    const unit = h.unit(ID);
    assert.ok(unit, '干员部署上场了');
    assert.equal(unit.skill.spec.kind, 'ammo', '技能 spec 来自 kit（否则会是通用 kit 的 instant）');
    assert.equal(unit.skill.spec.ammo, 5, '弹药数读的是 bb.trigger_time');
    assert.equal(unit.skill.spec.mods.atkPct, 0.5, '技能加成读的是 bb.atk');
    assert.equal(unit.skill.spec.attack.atkScale, 1.4, '攻击倍率读的是 bb.atk_scale');
  });

  test('示例 kit 的天赋在真实战斗里：技能激活叠 1 层、击杀叠到 5 层封顶、技能结束清空', async () => {
    const kitFn = await loadKit(SRC);
    const h = makeBattle({
      defs: { chess: { [ID]: chessRec({ id: ID, baseId: ID, skill: { bb: { trigger_time: 5, atk: 0.5, atk_scale: 1.4 }, spCost: 5, initSp: 5 } }) }, enemies: { enemy_test: enemyRec({ key: 'enemy_test', hp: 5000 }) } },
      units: [{ chessId: ID, row: 10, col: 4, uid: 1 }],
      enemies: [{ key: 'enemy_test', hp: 5000, time: 0 }],
      kits: { [ID]: kitFn },
      autoFinish: false,
      timeLimit: 60,
    });
    h.step();
    const unit = h.unit(ID);
    const stacks = () => unit.findBuff('kit:tide')?.stacks ?? 0;

    assert.equal(stacks(), 0, '技能没开之前没有层数');
    assert.equal(unit.skill.activate('test', { free: true }), true, '技能能激活（kit 的 skill spec 是可用的）');
    assert.equal(stacks(), 1, 'skillStart 上第一层');

    // 真的击杀（走引擎的伤害 → kill 钩子），不是手搓 emit
    for (let i = 0; i < 8; i++) {
      const e = h.spawn('enemy_test');
      assert.ok(e, '敌人刷出来了');
      h.b.step();
      h.b.dealDamage(unit, e, { amount: 999999 });
      h.b.step();
    }
    assert.equal(stacks(), 5, '叠到 maxStacks 就封顶');
    assert.ok(unit.s.atk > 500, `叠层真的加了攻击力（现在是 ${unit.s.atk}）`);

    unit.skill.end('test');
    assert.equal(stacks(), 0, 'onEnd 把层数清干净了');
    assert.equal(Math.round(unit.s.atk), 500, '技能加成与叠层一起被摘掉，回到基础攻击力');
    checkInvariants(h.b);
  });

  test('文档里的钩子词表与引擎的词表一致（漏一个就会让创作者写出永不触发的钩子）', () => {
    const missing = HOOK_EVENTS.filter((name) => !DOC.includes(`\`${name}\``));
    assert.deepEqual(missing, [], '这些钩子没有写进 docs/prompts/kit.md 的词表');
  });
});
