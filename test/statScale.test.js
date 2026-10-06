// test/statScale.test.js — 数值尺子（editor/ui/statScale.js）：干员页与怪物页共用同一份实现。
//
// 这条尺子是这次「新建更容易」里最不起眼、但最需要正确的东西：它要是算错了，作者会照着一个错的区间
// 去调数值，比没有参照更糟。所以边界都钉住：区间退化成一个点、值不是数字、没有参照数据。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtNum, statRefView, makeStatBar } from '../editor/ui/statScale.js';

describe('数值尺子：换算', () => {
  test('statRefView 给出刻度与「低于 / 在区间内 / 超出」', () => {
    const ref = { min: 100, p50: 200, max: 300, count: 12 };
    assert.equal(statRefView(200, ref).where, 'in');
    assert.equal(statRefView(200, ref).ratio, 0.5);
    assert.equal(statRefView(999, ref).where, 'above');
    assert.equal(statRefView(999, ref).ratio, 1);
    assert.equal(statRefView(1, ref).where, 'below');
    assert.equal(statRefView(1, ref).ratio, 0);
    assert.deepEqual(statRefView(200, ref).ref, { min: 100, p50: 200, max: 300 });
  });

  test('没有参照（或值不是数字）时返回 null，界面就不画尺子', () => {
    assert.equal(statRefView(10, null), null);
    assert.equal(statRefView(10, undefined), null);
    assert.equal(statRefView(NaN, { min: 1, p50: 2, max: 3 }), null);
  });

  test('区间退化成一个点时画在中间，不算出 NaN', () => {
    const view = statRefView(1, { min: 1, p50: 1, max: 1 });
    assert.equal(view.ratio, 0.5);
    assert.equal(view.where, 'in');
  });

  test('fmtNum：整数不带小数点，小数最多一位', () => {
    assert.equal(fmtNum(1400), '1400');
    assert.equal(fmtNum(1.25), '1.3');
    assert.equal(fmtNum(0.85), '0.9');
    assert.equal(fmtNum(-0), '0');
  });
});

describe('数值尺子：画出来的东西', () => {
  /** 一个只会记账的 h：够 makeStatBar 用，也能把画出来的结构摊开来看。 */
  const h = (tag, attrs = {}, ...kids) => ({ tag, attrs, kids: kids.flat().filter((k) => k !== null && k !== undefined) });
  const t = (zh, ...args) => (args.length ? zh.replace(/\{(\d+)\}/g, (w, i) => String(args[Number(i)])) : zh);
  const bar = makeStatBar(h, t);

  test('文本里写明官方区间与中位，越界时多一句', () => {
    const ref = { min: 900, p50: 1200, max: 1800 };
    const inside = JSON.stringify(bar(1400, ref));
    assert.match(inside, /官方区间 900–1800（中位 1200）/);
    assert.doesNotMatch(inside, /高于官方上限/);
    assert.match(JSON.stringify(bar(9000, ref)), /高于官方上限/);
    assert.match(JSON.stringify(bar(10, ref)), /低于官方下限/);
  });

  test('没有参照数据时返回 null（而不是画一根空尺子）', () => {
    assert.equal(bar(100, undefined), null);
    assert.equal(bar(100, null), null);
  });

  test('刻度标记按比例摆放', () => {
    const el = bar(1350, { min: 900, p50: 1200, max: 1800 });
    const track = el.kids[0];
    const mark = track.kids[0];
    assert.match(mark.attrs.style, /left:50\.0%/);
  });
});
