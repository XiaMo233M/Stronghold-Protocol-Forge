// test/stageRoundBind.test.js — 「出怪表 → 回合」这条链路在**编辑器服务端**的两头：
// 一头是地图页要的数据（`/api/stages` 的 `roundBind`），另一头是保存时**不能把回合绑定吞掉**。
//
// 后半条是一个具体的回归：地图页拼 spec 是显式列字段的，`rounds` 曾经不在那份清单里 ——
// 于是「打开一张已经绑好回合的地图、随手保存一下」就会把绑定删干净，而且没有任何提示。
// 引擎侧的语义（哪一回合用哪张表、写错 id 会回落）已有 test/workshopStageRounds.test.js 覆盖，这里只管编辑器这两头。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { TILE_PALETTE } from '../shared/stageAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'config.json'), 'utf8'));
const WAVES = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'waves.json'), 'utf8'));

const PACK = 'rounds-pack';
const MODE = 'mode_single_funny';
const BOSS_ROUND = 9;
const OFFICIAL_WAVE = Object.keys(WAVES)[0];

/** 一张最小但合法的地图（与 test/forgeNotice.test.js 里那份同形）。 */
function stageSpec(extra = {}) {
  return {
    id: 'ws_rounds_map', name: '回合绑定测试图', weight: 40, modes: [MODE],
    rows: Array.from({ length: 19 }, (_, r) => (r === 9 ? `S${'r'.repeat(19)}E` : 'r'.repeat(21))),
    tiles: Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, {
      tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
      groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: t.special ?? null, bb: {},
    }])),
    devices: [],
    options: { characterLimit: 8, moveMultiplier: 0.5 },
    routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }],
    ...extra,
  };
}

let tmp;
let wsRoot;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-roundbind-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(join(wsRoot, PACK), { recursive: true });
  fs.writeFileSync(join(wsRoot, PACK, 'pack.json'), JSON.stringify({
    id: PACK, name: '回合绑定夹具包', version: '0.1.0', author: '测试作者', license: null, description: null,
    gameVersion: '0.1.3', content: ['stages'], overrides: [],
  }, null, 2));
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});

after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (p) => fetch(`${editor.url}${p}`);
const post = (p, body) => fetch(`${editor.url}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('回合绑定：地图页要的数据', () => {
  test('/api/stages 给出可选的出怪表（官方都在，且不带包名）', async () => {
    const data = await get('/api/stages').then((r) => r.json());
    const official = data.roundBind.waves.filter((w) => !w.pack).map((w) => w.id);
    assert.deepEqual(official.sort(), Object.keys(WAVES).sort(), '官方 38 张表要一张不少');
    assert.ok(data.roundBind.waves.every((w) => typeof w.id === 'string' && w.id), '每条都得有 id');
  });

  test('每个模式的回合表与首领清单与 config 一致', async () => {
    const data = await get('/api/stages').then((r) => r.json());
    const ids = Object.keys(CONFIG.modes);
    assert.deepEqual(Object.keys(data.roundBind.modes).sort(), ids.sort());
    for (const id of ids) {
      const got = data.roundBind.modes[id];
      const want = CONFIG.modes[id];
      const rounds = Object.keys(want.rounds).map(Number).sort((a, b) => a - b);
      assert.deepEqual(got.rounds.map((r) => r.round), rounds, `${id} 的回合号`);
      assert.equal(got.rounds[0].template, want.rounds[rounds[0]].template ?? null, `${id} 的默认模板`);
      assert.deepEqual(got.bosses, Object.keys(want.bossWeights ?? {}).sort(), `${id} 的首领清单`);
    }
    // 首领回合必须被标出来，否则界面无法为它单独给一个下拉
    assert.deepEqual(data.roundBind.modes[MODE].rounds.filter((r) => r.isBoss).map((r) => r.round), [BOSS_ROUND]);
  });
});

describe('回合绑定：保存不能把它吞掉', () => {
  test('带 rounds / bossRounds 的 spec 存下去，生成的记录里还在', async () => {
    const spec = stageSpec({
      rounds: { 3: OFFICIAL_WAVE },
      bossRounds: { [BOSS_ROUND]: { boss_1: OFFICIAL_WAVE } },
    });
    const saved = await post(`/api/packs/${PACK}/stages`, { spec });
    assert.equal(saved.status, 200, await saved.text());

    const records = JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'stages.json'), 'utf8'));
    const rec = records.ws_rounds_map;
    assert.ok(rec, '记录应该生成出来');
    assert.deepEqual(rec.rounds, { 3: OFFICIAL_WAVE }, 'rounds 必须原样进记录（引擎真正读的就是它）');
    assert.deepEqual(rec.bossRounds, { [BOSS_ROUND]: { boss_1: OFFICIAL_WAVE } });
  });

  test('再存一次（例如只改了名字）回合绑定仍然在', async () => {
    await post(`/api/packs/${PACK}/stages`, { spec: stageSpec({ name: '改了个名字', rounds: { 3: OFFICIAL_WAVE } }) });
    const records = JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'stages.json'), 'utf8'));
    assert.deepEqual(records.ws_rounds_map.rounds, { 3: OFFICIAL_WAVE });
    assert.equal(records.ws_rounds_map.name, '改了个名字');
  });

  test('没绑回合的地图不会凭空多出这两个字段', async () => {
    const spec = { ...stageSpec({ id: 'ws_plain_map' }) };
    await post(`/api/packs/${PACK}/stages`, { spec });
    const records = JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'stages.json'), 'utf8'));
    assert.equal(records.ws_plain_map.rounds, undefined);
    assert.equal(records.ws_plain_map.bossRounds, undefined);
  });

  test('绑了一个不存在的表：保存照样成功（校验只查形状），所以界面必须自己查', async () => {
    // 这条不是「期望的行为」，而是把现实钉住：引擎解析不到 id 会静默回落，格式层不拦 ——
    // 正因如此 editor/ui/stageRounds.js 的 missingBindings 才必须在页面上把话说出来。
    const spec = stageSpec({ id: 'ws_typo_map', rounds: { 4: 'wave_typo_不存在' } });
    const saved = await post(`/api/packs/${PACK}/stages`, { spec });
    assert.equal(saved.status, 200);
    const records = JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'stages.json'), 'utf8'));
    assert.deepEqual(records.ws_typo_map.rounds, { 4: 'wave_typo_不存在' });
  });
});
