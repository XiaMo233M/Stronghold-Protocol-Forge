// test/templateEndpoints.test.js — 「以现成内容为模板新建」在编辑器服务端的三个入口。
//
// 前端要的东西很具体：一张能选的模板清单（官方 266 个干员 / 249 只怪），选中之后拿到一份**能直接继续编辑、
// 且派生得出来**的 spec；再配一把数值尺子（同类内容的 min/中位/max）。所以这里查的不是「接口返回 200」，
// 而是：拿到的 spec 真的能通过 /api/preview 派生，且外观（spine）等最容易丢的字段与原记录一致。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHESS = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'chess.json'), 'utf8'));
const ENEMIES = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'enemies.json'), 'utf8'));

let tmp;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-template-'));
  editor = await createEditorServer({
    workshopRoot: join(tmp, 'workshop'), port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json'),
  });
});

after(async () => {
  await editor.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p) => fetch(`${editor.url}${p}`);
const post = (p, body) => fetch(`${editor.url}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** 一个能当模板的官方干员：有外观、有技能。 */
const OP_ID = Object.entries(CHESS).find(([, r]) => r && !r.isGolden && r.visible && !r.isHidden && !r.isDiy && r.assets?.spine && r.skill)?.[0];
/** 一只带 spine 的官方怪。 */
const ENEMY_KEY = Object.entries(ENEMIES).find(([, r]) => r && r.spine)?.[0];

describe('模板新建：服务端接口', () => {
  test('/api/state 带上数值参照（按职业分组，7 个字段）', async () => {
    const st = await get('/api/state').then((r) => r.json());
    assert.ok(st.officialChess.length > 100);
    assert.equal(typeof st.officialChess[0].stats.maxHp, 'number', '官方干员要带上数值，页面才能画尺子');
    assert.ok(st.statRanges && Object.keys(st.statRanges).length >= 8, '八个职业都该有区间');
    for (const field of ['maxHp', 'atk', 'def', 'res', 'cost', 'blockCnt', 'bat']) {
      const s = st.statRanges.SNIPER[field];
      assert.ok(s && s.min <= s.p50 && s.p50 <= s.max && s.count > 0, `SNIPER 的 ${field} 区间要合理`);
    }
  });

  test('干员模板：拿到 spec 且能直接派生通过（0 错误）', async () => {
    assert.ok(OP_ID, 'data/chess.json 里应该有可当模板的干员');
    const r = await get(`/api/operators/template?chessId=${encodeURIComponent(OP_ID)}`);
    assert.equal(r.status, 200);
    const { spec, baseId } = await r.json();
    assert.equal(spec.id, '', '模板不能顺手把原干员的 id 复制过来');
    assert.equal(baseId, OP_ID);
    assert.equal(spec.assetsSpine, CHESS[OP_ID].assets.spine, '外观必须带对：填错只会静默变替代外观');

    const pv = await post('/api/preview', { spec: { ...spec, id: 'tmpl_probe' } }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.deepEqual(pv.errors, []);
  });

  test('干员模板：不认识的 id 返回 404，不是 500', async () => {
    assert.equal((await get('/api/operators/template?chessId=nope_1')).status, 404);
    assert.equal((await get('/api/operators/template')).status, 404);
  });

  test('怪物接口带上模板清单、spine 候选与数值参照', async () => {
    const data = await get('/api/enemies').then((r) => r.json());
    assert.equal(data.officialTemplates.length, Object.keys(ENEMIES).length, '官方怪物清单要齐');
    assert.ok(data.spineChoices.length > 100, 'spine 候选要够多（这是「填错就静默变占位图」的那个字段）');
    for (const c of data.spineChoices) {
      assert.ok(typeof c.id === 'string' && c.id, 'spine 候选要有 id');
      assert.ok(data.officialTemplates.some((e) => e.spine === c.id), `候选 ${c.id} 必须真的属于某只官方怪`);
    }
    assert.ok(data.statRanges.NORMAL.maxHp.count > 50);
    assert.ok(data.statRanges.ELITE.maxHp.p50 > data.statRanges.NORMAL.maxHp.p50);
  });

  test('怪物模板：拿到 spec 且能直接派生通过（0 错误）', async () => {
    assert.ok(ENEMY_KEY, 'data/enemies.json 里应该有可当模板的怪');
    const r = await get(`/api/enemies/template?key=${encodeURIComponent(ENEMY_KEY)}`);
    assert.equal(r.status, 200);
    const { spec } = await r.json();
    assert.equal(spec.id, '', '模板不能顺手把原怪的 key 复制过来');
    assert.equal(spec.spine, ENEMIES[ENEMY_KEY].spine);

    const pv = await post('/api/enemies/preview', { spec: { ...spec, id: 'tmpl_probe' } }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.deepEqual(pv.errors, []);
  });

  test('怪物模板：不认识的 key 返回 404', async () => {
    assert.equal((await get('/api/enemies/template?key=enemy_nope')).status, 404);
    assert.equal((await get('/api/enemies/template')).status, 404);
  });
});
