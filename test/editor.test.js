// test/editor.test.js — the standalone 工坊编辑器 (editor/server.mjs, tools/workshop-editor.mjs; docs/EDITOR.md).
//
// The boundary is the point of this suite: the editor is an OPTION. It lives outside `public/`, the game server mounts
// only /data /shared /sim and public/, and no game-client source mentions it — so a web client (or a later APK) can
// never load it. Everything else here checks the editor actually works: derive → write specs + generated records →
// reload → the engine accepts it, plus the 「是否助战」 switch writing the server's support pool.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer, UI_DIR } from '../editor/server.mjs';
import { startServer, WORKSHOP_ASSET_PREFIX } from '../server/index.js';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';
import { checkSupport, normalizeSupportConfig } from '../shared/support.js';
import { TILE_PALETTE } from '../shared/stageAuthoring.js';
import { attrPowerOf, battleEffectivenessOf } from '../shared/enemyAuthoring.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

// 一个真的存在于本机模型清单里的 spine id：不指定外观的话，试玩里这个干员是一张头像贴图，编辑器现在会**拒绝**保存
// （见 editor/server.mjs assetSpineIssues）。清单缺失时留空 —— 那种环境下编辑器不判定，测试也不必假装有模型。
const SOME_SPINE = (() => {
  try { return Object.keys(JSON.parse(fs.readFileSync(join(DATA_DIR, 'assets.json'), 'utf8')).chars || {})[0] ?? ''; } catch { return ''; }
})();

const SPEC = {
  id: 'editor_made',
  name: '编辑器干员',
  tier: 5,
  profession: 'SNIPER',
  subProfessionId: 'fastshot',
  position: 'RANGED',
  assetsSpine: SOME_SPINE,
  stats: {
    normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
    golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 1, bat: 1.0 },
  },
  skill: { name: '试作', desc: '攻击力+50%', skillType: 'MANUAL', durationType: 'NONE', spType: 'INCREASE_WITH_TIME', spCost: 25, initSp: 10, duration: 15, bb: { atk: 0.5 } },
};

const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJs(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let tmp;
let wsRoot;
let supportFile;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
  // a throwaway copy of the support config, so these tests never rewrite the repo's data/support.json
  supportFile = join(tmp, 'support.json');
  fs.copyFileSync(join(DATA_DIR, 'support.json'), supportFile);
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workshop editor: the option boundary (the client must not contain it)', () => {
  test('it lives outside public/, so the game server cannot serve it', async () => {
    assert.equal(fs.existsSync(join(ROOT, 'public/editor')), false, 'the editor must not live under public/');
    assert.equal(fs.existsSync(UI_DIR), true, 'the editor UI must exist');
    const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      for (const p of ['/editor/server.mjs', '/editor/ui/app.js', '/editor/ui/index.html', '/editor/']) {
        const res = await fetch(game.url + p);
        assert.equal(res.status, 404, `${p} must not be reachable from the game server`);
      }
      // the client's own files still work
      assert.equal((await fetch(`${game.url}/data/support.json`)).status, 200);
    } finally {
      await game.close();
    }
  });

  test('no game-client source references the editor', () => {
    const offenders = [];
    for (const file of [...walkJs(join(ROOT, 'public/js')), ...walkJs(join(ROOT, 'shared')), join(ROOT, 'public/index.html')]) {
      const text = fs.readFileSync(file, 'utf8');
      if (/workshop-editor|editor\/server|editor\/ui|\.\.\/editor/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'the game client and shared code must not import the editor');
  });
});

describe('workshop editor: the API', () => {
  const api = (p, opts) => fetch(editor.url + p, opts);

  test('GET /api/state reports the root, the official operators and the support config', async () => {
    const r = await api('/api/state').then((x) => x.json());
    assert.equal(r.workshopRoot, wsRoot);
    assert.deepEqual(r.packs, []);
    assert.ok(r.officialChess.length > 100, 'the spine picker needs the official operators');
    assert.equal(r.support.enabled, true);
    assert.ok(r.officialChess.every((c) => c.id && c.name && Number.isInteger(c.tier)));
    // 分支按职业联动：`subProfessions` 从**全部**非精锐记录算出来（不是只从可见干员），所以只在一条
    // 不可见记录上出现的 `pusher`（推击手）也在 —— 作者仍然应该能选到它。
    assert.ok(Array.isArray(r.subProfessions) && r.subProfessions.length >= 50, `官方 57 个分支都要在，实际 ${r.subProfessions?.length}`);
    assert.ok(r.subProfessions.every((b) => b.id && Array.isArray(b.professions)));
    assert.deepEqual(r.subProfessions.find((b) => b.id === 'pusher'), { id: 'pusher', name: '推击手', professions: ['SPECIAL'] });
    const sniper = r.subProfessions.filter((b) => b.professions.includes('SNIPER'));
    assert.ok(sniper.length >= 5, `狙击职业要有它的分支，实际 ${sniper.length}`);
    assert.ok(sniper.every((b) => b.professions.length === 1), '官方数据里没有分支跨职业');
    assert.ok(r.subProfessions.every((b) => typeof b.name === 'string' && b.name), '每个分支都有中文名（界面显示它）');
  });

  test('POST /api/preview derives and validates without writing anything', async () => {
    const good = await post(`${editor.url}/api/preview`, { spec: SPEC }).then((r) => r.json());
    assert.equal(good.ok, true, JSON.stringify(good.errors));
    assert.equal(good.base.chessId, 'chess_ws_editor_made_a');
    assert.equal(good.base.name, '编辑器干员');
    assert.equal(good.golden.stats.maxHp, 1800);
    const bad = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, tier: 99, stats: {} } }).then((r) => r.json());
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 3);
    assert.equal(fs.existsSync(join(wsRoot, 'editor_made')), false, 'a preview must not write');
  });

  test('the talents the form edits reach the record, and a talent with no desc is marked hidden', async () => {
    const spec = {
      ...SPEC,
      talents: [
        { name: '有说明的天赋', desc: '攻击力提升', bb: { atk_scale: 1.2 } },
        { name: '没有说明的天赋', bb: { def: 0.1 } },
      ],
    };
    const r = await post(`${editor.url}/api/preview`, { spec }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.base.talents.length, 2, 'both talents must reach the record');
    assert.equal(r.base.talents[0].name, '有说明的天赋');
    assert.deepEqual(r.base.talents[0].bb, { atk_scale: 1.2 }, 'the blackboard is carried verbatim');
    assert.equal(r.base.talents[0].hidden, false, 'a talent with a description is visible');
    assert.equal(r.base.talents[1].hidden, true, 'a talent with no description is hidden — the form hint promises this');
    // the golden form is a separate record and carries its own copy (the form edits them once, the derive duplicates)
    assert.equal(r.golden.talents.length, 2);
    // and a spec with no talents is still valid (an operator without a talent is legal)
    const none = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, talents: [] } }).then((x) => x.json());
    assert.equal(none.ok, true, JSON.stringify(none.errors));
    assert.deepEqual(none.base.talents, []);
  });

  test('a spec with an unreadable blackboard key warns but still passes', async () => {
    const r = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, skill: { ...SPEC.skill, bb: { atk: 0.5, nonsense_key: 1 } } } }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.includes('nonsense_key')), JSON.stringify(r.warnings));
  });

  test('POST /operators creates the pack, the spec and the generated records', async () => {
    const r = await post(`${editor.url}/api/packs/my-pack/operators`, { spec: SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'editor_made');
    const packDir = join(wsRoot, 'my-pack');
    const manifest = JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8'));
    assert.equal(manifest.id, 'my-pack', 'the pack id must equal its directory name');
    assert.deepEqual(manifest.content, ['chess']);
    assert.equal(fs.existsSync(join(packDir, 'specs/editor_made.json')), true, 'the editable spec is the source of truth');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.deepEqual(Object.keys(records).sort(), ['chess_ws_editor_made_a', 'chess_ws_editor_made_b']);
  });

  test('the saved operator reaches the engine as a shop-eligible operator', async () => {
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes('chess_ws_editor_made_a'));
    assert.equal(gd.tierOf('chess_ws_editor_made_a'), 5);
    assert.equal(gd.goldenIdOf('chess_ws_editor_made_a'), 'chess_ws_editor_made_b');
    assert.equal(data.chess['chess_ws_editor_made_a'].name, '编辑器干员');
  });

  test('GET /api/state now lists the operator as editor-managed', async () => {
    const r = await api('/api/state').then((x) => x.json());
    assert.equal(r.packs.length, 1);
    const pack = r.packs[0];
    assert.equal(pack.specs.length, 1);
    assert.equal(pack.specs[0].id, 'editor_made');
    const base = pack.operators.find((o) => o.chessId === 'chess_ws_editor_made_a');
    assert.equal(base.managed, true);
    assert.deepEqual(base.issues.filter((i) => i.severity === 'error'), []);
  });

  test('a record the editor does not own is preserved when a spec is saved', async () => {
    const packDir = join(wsRoot, 'my-pack');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    records['chess_ws_handwritten_a'] = { ...records['chess_ws_editor_made_a'], chessId: 'chess_ws_handwritten_a', baseId: 'chess_ws_handwritten_a', goldenId: null, name: '手工记录' };
    fs.writeFileSync(join(packDir, 'chess.json'), JSON.stringify(records));
    // re-save the spec: the hand-written record must survive
    await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, name: '改过名字' } });
    const after = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.equal(after['chess_ws_handwritten_a'].name, '手工记录', 'a record with no spec must never be destroyed');
    assert.equal(after['chess_ws_editor_made_a'].name, '改过名字', 'the spec owns its records and regenerates them');
  });

  test('the 是否助战 switch writes the server support pool, and checkSupport accepts it', async () => {
    const before = JSON.parse(fs.readFileSync(supportFile, 'utf8'));
    assert.equal((before.pool['5'] || []).includes('chess_ws_editor_made_a'), false);
    const on = await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_ws_editor_made_a', tier: 5, enabled: true }).then((r) => r.json());
    assert.equal(on.ok, true);
    const written = JSON.parse(fs.readFileSync(supportFile, 'utf8'));
    assert.ok(written.pool['5'].includes('chess_ws_editor_made_a'), 'the id must be in the tier-5 pool');
    assert.equal(written.note, before.note, 'unknown keys of the config must be preserved');
    // and the server-side validator accepts it against the merged data
    const data = loadData(DATA_DIR, { log: { info() {}, warn() {}, error() {}, debug() {} }, workshopDir: wsRoot });
    const cfg = normalizeSupportConfig(written);
    const checked = checkSupport(['chess_ws_editor_made_a'], cfg, (id) => data.chess[id] || null);
    assert.equal(checked.ok, true, JSON.stringify(checked));
    const off = await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_ws_editor_made_a', tier: 5, enabled: false }).then((r) => r.json());
    assert.equal(off.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(supportFile, 'utf8')).pool['5'].includes('chess_ws_editor_made_a'), false);
  });

  test('DELETE removes the spec and the records it owned', async () => {
    const r = await fetch(`${editor.url}/api/packs/my-pack/operators/editor_made`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(join(wsRoot, 'my-pack/specs/editor_made.json')), false);
    const records = JSON.parse(fs.readFileSync(join(wsRoot, 'my-pack/chess.json'), 'utf8'));
    assert.equal(records['chess_ws_editor_made_a'], undefined);
    assert.equal(records['chess_ws_editor_made_b'], undefined);
    assert.ok(records['chess_ws_handwritten_a'], 'the unowned record stays');
  });

  test('bad ids and unknown routes are refused', async () => {
    assert.equal((await post(`${editor.url}/api/packs/bad%20id/operators`, { spec: SPEC })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: '' } })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/packs/x/operators/..%2F..%2Fetc`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${editor.url}/../server/index.js`)).status, 404);
  });

  test("the editor's own UI is served (and only from its own directory)", async () => {
    const html = await api('/').then((r) => r.text());
    assert.match(html, /创意工坊编辑器/);
    assert.equal((await api('/app.js')).status, 200);
    // the 2D map placer is part of the editor, and only of the editor
    const placer = await api('/stage.html').then((r) => r.text());
    assert.match(placer, /工坊地图设计器/);
    assert.equal((await api('/stage.js')).status, 200);
    assert.equal((await fetch(`${editor.url}/../data/chess.json`)).status, 404, 'the editor must not become a file server');
  });

  test('a sibling spec that no longer derives cannot cause silent record loss', async () => {
    const packDir = join(wsRoot, 'my-pack');
    await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: 'keepme', name: 'Keep' } });
    const before = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
    assert.ok(before['chess_ws_keepme_a'], 'the fixture operator must exist');

    // break a DIFFERENT spec by hand: tier 7 and empty stats can never derive
    const brokenPath = join(packDir, 'specs', 'broken.json');
    fs.writeFileSync(brokenPath, JSON.stringify({ id: 'broken', name: 'B', tier: 7, profession: 'WARRIOR', position: 'MELEE', stats: { normal: {}, golden: {} } }));
    try {
      const res = await post(`${editor.url}/api/packs/my-pack/operators`, { spec: { ...SPEC, id: 'other', name: 'Other' } });
      assert.equal(res.status, 400, 'the save must be refused rather than write a pack that lost records');
      const body = await res.json();
      assert.ok(body.errors && body.errors.some((e) => e.slug === 'broken'), JSON.stringify(body));
      const after = JSON.parse(fs.readFileSync(join(packDir, 'chess.json'), 'utf8'));
      assert.ok(after['chess_ws_keepme_a'], 'an unrelated operator\'s records must survive a broken sibling spec');
    } finally {
      fs.rmSync(brokenPath);
    }
  });

  test('the support toggle validates the id and the tier it is given', async () => {
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_does_not_exist', tier: 5, enabled: true })).status, 400);
    // the client supplies the tier: a wrong one must not be persisted as junk config
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 6, enabled: true })).status, 400);
    assert.equal((await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 5, enabled: true })).status, 200);
    assert.ok(JSON.parse(fs.readFileSync(supportFile, 'utf8')).pool['5'].includes('chess_char_5_01_a'));
    await post(`${editor.url}/api/support/toggle`, { chessId: 'chess_char_5_01_a', tier: 5, enabled: false });
  });
});

// 「试玩里摇不到我的自定义干员」的根因就在这里：一个包可能先被别的页面建出来（content: ["stages"]…），
// 之后往它里面存干员时，如果 `content` 不补上 "chess"，加载器就**完全不读这个包的 chess.json** ——
// 干员在编辑器里、在磁盘上、语法都对，却永远进不了游戏，而且没有任何报错。
describe('workshop editor: 保存干员必须补上 content 里的 chess', () => {
  const PACK = 'stages-first';
  const localApi = (p, opts) => fetch(editor.url + p, opts);
  const manifestOf = () => JSON.parse(fs.readFileSync(join(wsRoot, PACK, 'pack.json'), 'utf8'));
  const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

  test('先在别的页面建的包（content: ["stages"]）会在这里补上 chess', async () => {
    const dir = join(wsRoot, PACK);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({ id: PACK, name: '先做了地图的包', version: '0.1.0', content: ['stages'] }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'stages.json'), `${JSON.stringify({ ws_first_map: { stageId: 'ws_first_map' } }, null, 2)}\n`);

    const r = await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: { ...SPEC, id: 'late_op', name: '后来加的干员' } }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(manifestOf().content, ['chess', 'stages'], 'content 必须同时声明 chess 与原有的 stages，且按字典序');
    assert.equal(manifestOf().name, '先做了地图的包', '补 content 不能顺手改掉别的字段');
  });

  test('这个干员真的进了加载器的数据，并且进得了商店池', async () => {
    const data = loadData(DATA_DIR, { log: quietLog, workshopDir: wsRoot });
    assert.ok(data.chess['chess_ws_late_op_a'], '加载器必须读到这个干员（这正是「摇不到」的反面）');
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.visibleChess.includes('chess_ws_late_op_a'), '它必须是商店可选干员');
    assert.equal(gd.tierOf('chess_ws_late_op_a'), 5);
    const pool = new SharedPool(gd, { banned: [] });
    assert.equal(pool.has('chess_ws_late_op_a'), true, '共享池里必须有它的拷贝，否则商店摇不到');
    assert.ok(pool.cap('chess_ws_late_op_a') > 0);
  });

  test('包管理页会点出「盘上有、content 没声明」的文件（手工编辑也躲不掉）', async () => {
    // 手工把 chess 从 content 里删掉：文件还在盘上，加载器却不会读它 —— 这一类必须被报出来
    fs.writeFileSync(join(wsRoot, PACK, 'pack.json'), `${JSON.stringify({ ...manifestOf(), content: ['stages'] }, null, 2)}\n`);
    const r = await localApi('/api/packs/support').then((x) => x.json());
    const summary = r.packs.find((p) => p.id === PACK);
    assert.ok(summary, '这个包必须出现在包管理页的列表里');
    assert.deepEqual(summary.undeclared, ['chess'], 'undeclared 要指出被忽略的那个文件');
    assert.equal(summary.status, 'loaded', '加载器仍然说这个包没问题 —— 所以这条提示是唯一的线索');
    // 再存一次干员就自动修好
    await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: { ...SPEC, id: 'late_op', name: '后来加的干员' } });
    const after = await localApi('/api/packs/support').then((x) => x.json());
    assert.deepEqual(after.packs.find((p) => p.id === PACK).undeclared, []);
  });

  // 「试玩里是一张贴图而不是模型」的第二半：编辑器不能再让一个没有模型的干员被存下去。
  test('没有模型的干员会被拒绝保存，并说清试玩里会画成什么', { skip: SOME_SPINE ? false : '本机没有 data/assets.json（模型清单），编辑器不判定外观' }, async () => {
    const noSpine = { ...SPEC, id: 'no_face', name: '没外观的干员' };
    delete noSpine.assetsSpine;
    const res = await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: noSpine });
    assert.equal(res.status, 400, '没有外观的干员不该被存下来');
    const body = await res.json();
    const issue = (body.errors || []).find((e) => e.code === 'NO_MODEL');
    assert.ok(issue, JSON.stringify(body));
    assert.match(issue.message, /贴图/, '错误必须说清会被画成贴图，而不是一句「缺少字段」');
    assert.equal(fs.existsSync(join(wsRoot, PACK, 'specs/no_face.json')), false, '被拒绝时不能留下半份 spec');
    // 空白外观与填错 id 是同一条规则
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: { ...SPEC, id: 'no_face2', assetsSpine: '' } })).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: { ...SPEC, id: 'no_face3', assetsSpine: 'char_does_not_exist' } })).status, 400);
    // 填表时就该看见：/api/preview 也报同一条
    const pv = await post(`${editor.url}/api/preview`, { spec: { ...SPEC, id: 'no_face4', assetsSpine: '' } }).then((r) => r.json());
    assert.equal(pv.ok, false);
    assert.ok(pv.errors.some((e) => e.code === 'NO_MODEL'));
    // 挑一个已装好的模型就能存
    const choices = (await localApi('/api/state').then((r) => r.json())).spineChoices;
    assert.ok(choices.length > 0);
    assert.equal((await post(`${editor.url}/api/packs/${PACK}/operators`, { spec: { ...SPEC, id: 'no_face5', assetsSpine: choices[0].id } })).status, 200);
  });

  test('外观候选来自本机的模型清单（chars 的键），不是随便一份列表', async () => {
    const st = await localApi('/api/state').then((r) => r.json());
    const ids = st.spineChoices.map((c) => c.id);
    assert.ok(ids.includes(SOME_SPINE), '清单里必须有真实存在的模型 id');
    assert.ok(ids.length >= 100, `本机装了 ${ids.length} 个干员模型`);
    assert.equal(new Set(ids).size, ids.length, '候选不能重复');
  });
});

describe('workshop editor: maps (the 2D placer API)', () => {
  const stageSpec = () => ({
    id: 'ws_editor_map', name: '编辑器地图', weight: 40, modes: ['mode_multi_normal'],
    rows: Array.from({ length: 19 }, (_, r) => (r === 9 ? `S${'r'.repeat(19)}E` : 'r'.repeat(21))),
    tiles: Object.fromEntries(TILE_PALETTE.map((t) => [t.glyph, {
      tileKey: t.tileKey, height: t.height, buildable: t.buildable, passable: t.passable,
      groundPassable: t.passable === 'ALL', flyPassable: t.passable !== 'NONE', special: t.special ?? null, bb: {},
    }])),
    devices: [{ key: 'trap_1105_accrate', pos: [11, 10], dir: 'UP', hidden: false, role: 'crate' }],
    options: { characterLimit: 8, moveMultiplier: 0.5 },
  });

  test('GET /api/stages exposes the palette, the grid size and the assignable modes', async () => {
    const r = await fetch(`${editor.url}/api/stages`).then((x) => x.json());
    assert.deepEqual(r.size, [19, 21]);
    assert.ok(r.palette.length > 10, 'the placer needs the palette');
    assert.ok(r.modes.length > 0, 'the placer needs the modes a map can be assigned to');
    assert.ok(r.modes.every((m) => m.id && m.name));
  });

  test('POST /api/stages/preview derives the paths only when they are asked for', async () => {
    // 新建的地图默认不带寻路：没画路线就不派生门到门路线（业主口径：自动寻路只能点按钮要）
    const r = await post(`${editor.url}/api/stages/preview`, { spec: stageSpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(Object.keys(r.record.groundPaths).length, 0, 'a map with no drawn route must not carry derived ground routes');
    assert.ok(r.record.deployTiles.normal.melee.length > 0);
    assert.equal(fs.existsSync(join(wsRoot, 'map-pack')), false, 'a preview must not write');
    // 显式传 paths 时仍然照老样子派生（「自动寻路」按钮走的就是这条路）
    const asked = await post(`${editor.url}/api/stages/preview`, { spec: stageSpec(), paths: true }).then((x) => x.json());
    assert.equal(asked.ok, true, JSON.stringify(asked.errors));
    assert.ok(Object.keys(asked.record.groundPaths).length > 0, 'the sim must derive ground routes when asked');
  });

  test('saving writes the spec and the generated record; deleting removes them', async () => {
    const saved = await post(`${editor.url}/api/packs/map-pack/stages`, { spec: stageSpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const packDir = join(wsRoot, 'map-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['stages']);
    assert.equal(fs.existsSync(join(packDir, 'stage-specs/ws_editor_map.json')), true, 'the spec is the editable source');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(join(packDir, 'stages.json'), 'utf8')).ws_editor_map.groundPaths).length, 0, 'no drawn route → no derived paths in the saved record');

    const listed = await fetch(`${editor.url}/api/stages`).then((x) => x.json());
    const found = listed.stages.find((s) => s.id === 'ws_editor_map');
    assert.ok(found && found.managed, 'the map must be listed as editor-managed');
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(found.deployMelee > 0, true);

    const del = await fetch(`${editor.url}/api/packs/map-pack/stages/ws_editor_map`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'stages.json'), 'utf8')).ws_editor_map, undefined);
  });

  test('an invalid map is refused with the reason', async () => {
    const bad = await post(`${editor.url}/api/packs/map-pack/stages`, { spec: { ...stageSpec(), rows: ['rrr'] } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'BAD_SIZE'), 'the size error must be reported');
    assert.equal((await post(`${editor.url}/api/packs/map-pack/stages`, { spec: { ...stageSpec(), id: 'has spaces' } })).status, 400);
  });

  test('routes travel in the spec, and the preview returns the sim walk for each', async () => {
    const spec = { ...stageSpec(), routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }] };
    const pv = await post(`${editor.url}/api/stages/preview`, { spec }).then((x) => x.json());
    assert.equal(pv.ok, true, JSON.stringify(pv.errors));
    assert.equal(pv.routePaths.length, 1, 'one authored route → one derived walk');
    assert.ok(Array.isArray(pv.routePaths[0].path) && pv.routePaths[0].path.length > 1, 'the sim must find a ground walk');
    assert.deepEqual(pv.routePaths[0].path[0], [9, 0]);
    assert.deepEqual(pv.routePaths[0].path.at(-1), [9, 20]);
    // routes belong to the WAVE, not to the stage record
    assert.equal(Object.hasOwn(pv.record, 'routes'), false);

    const saved = await post(`${editor.url}/api/packs/map-pack/stages`, { spec }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const stored = JSON.parse(fs.readFileSync(join(wsRoot, 'map-pack', 'stage-specs', 'ws_editor_map.json'), 'utf8'));
    assert.deepEqual(stored.routes, spec.routes, 'the placer must be able to re-open what it drew');
    // and a route nothing can walk is refused
    const walled = { ...spec, rows: Array.from({ length: 19 }, () => `${'r'.repeat(10)}X${'r'.repeat(10)}`) };
    walled.rows[9] = `S${'r'.repeat(9)}X${'r'.repeat(9)}E`;
    const blocked = await post(`${editor.url}/api/stages/preview`, { spec: walled }).then((x) => x.json());
    assert.equal(blocked.ok, false);
    assert.ok(blocked.errors.some((e) => e.code === 'ROUTE_NOPATH'), JSON.stringify(blocked.errors));
  });
});

describe('workshop editor: monsters (the enemy form API)', () => {
  const enemySpec = () => ({
    id: 'frost_hound', name: '霜牙猎犬', rank: 'ELITE', applyWay: 'MELEE', motion: 'WALK', dmgType: 'phys',
    desc: '被源石侵蚀的猎犬。',
    stats: { maxHp: 4200, atk: 620, def: 180, res: 20, moveSpeed: 1.6, bat: 1.3, blockCnt: 1, massLevel: 2 },
    abilities: [{ text: '无法被阻挡' }, { text: '被击倒时使周围减速' }],
    talents: { bb: { move_speed: 0.3 } }, skills: [], tags: ['origen'],
    immunities: { silence: true, frozen: true }, spine: 'enemy_1007_slime', beFactor: 1,
  });

  test('GET /api/enemies exposes the vocabularies the form renders and the official keys', async () => {
    const r = await fetch(`${editor.url}/api/enemies`).then((x) => x.json());
    for (const k of ['ranks', 'motions', 'dmgTypes', 'applyWays', 'acTypes', 'immunities', 'statDefaults']) {
      assert.ok(r.vocab[k] && (Array.isArray(r.vocab[k]) ? r.vocab[k].length : Object.keys(r.vocab[k]).length), `vocab.${k} is empty`);
    }
    assert.ok(r.officialEnemies.length > 100, 'the official roster must be listed for the collision check');
  });

  test('preview derives attrPower and be without writing', async () => {
    const r = await post(`${editor.url}/api/enemies/preview`, { spec: enemySpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.record.key, 'enemy_ws_frost_hound');
    assert.equal(r.record.attrPower, attrPowerOf(r.record.stats));
    assert.equal(r.record.be, battleEffectivenessOf(r.record.stats, 1));
    assert.equal(r.record.tokenOnly, false, 'a workshop monster is spawned by a wave, not only by a token');
    assert.equal(fs.existsSync(join(wsRoot, 'monster-pack')), false, 'a preview must not write');
  });

  test('saving writes the spec and the generated record; deleting removes them', async () => {
    const saved = await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: enemySpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.key, 'enemy_ws_frost_hound');
    const packDir = join(wsRoot, 'monster-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['enemies']);
    assert.equal(fs.existsSync(join(packDir, 'enemy-specs/frost_hound.json')), true, 'the spec is the editable source');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'enemies.json'), 'utf8'));
    assert.ok(records['enemy_ws_frost_hound'].attrPower, 'the generated record carries the derived metrics');

    const listed = await fetch(`${editor.url}/api/enemies`).then((x) => x.json());
    const found = listed.enemies.find((e) => e.key === 'enemy_ws_frost_hound');
    assert.ok(found && found.managed);
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(found.abilities, 2);

    const del = await fetch(`${editor.url}/api/packs/monster-pack/enemies/enemy_ws_frost_hound`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'enemies.json'), 'utf8'))['enemy_ws_frost_hound'], undefined);
  });

  test('an invalid monster is refused with the reason', async () => {
    const bad = await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: { ...enemySpec(), stats: { maxHp: -1 } } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'BAD_NUMBER'), 'the number error must be reported');
    assert.equal((await post(`${editor.url}/api/packs/monster-pack/enemies`, { spec: { ...enemySpec(), id: '!!!' } })).status, 400);
  });

  test('the monster page is part of the editor, and only of the editor', async () => {
    const html = await fetch(`${editor.url}/enemy.html`).then((r) => r.text());
    assert.match(html, /工坊怪物编辑器/);
    assert.equal((await fetch(`${editor.url}/enemy.js`)).status, 200);
  });
});

describe('workshop editor: waves (the timeline API)', () => {
  const waveSpec = () => ({
    id: 'round_two_hounds', kind: 'normal', characterLimit: 8,
    routes: [{ motion: 'WALK', start: [9, 0], end: [9, 20], checkpoints: [] }],
    spawns: [
      { time: 3, key: 'enemy_1007_slime', count: 2, interval: 5, routeIndex: 0, slot: 'N' },
      { time: 20, key: 'enemy_1007_slime', count: 1, interval: 0, routeIndex: 0, slot: 'NF', unharmful: true },
      { time: 30, key: 'enemy_1007_slime', count: 3, interval: 4, routeIndex: 0, slot: 'E' },
    ],
    usedBy: [{ modeId: 'mode_multi_normal', round: 2 }],
  });

  test('GET /api/waves exposes the vocabularies, the enemy keys, the modes and the maps', async () => {
    const r = await fetch(`${editor.url}/api/waves`).then((x) => x.json());
    assert.ok(r.vocab.kinds.includes('normal'));
    assert.ok(r.vocab.slots.includes('N') && r.vocab.slots.includes('EF'));
    assert.ok(r.vocab.spawnFields.includes('routeIndex'), 'the form must know the engine-readable spawn fields');
    assert.equal(r.vocab.roundsPerMode, 15);
    assert.ok(r.enemies.length > 100, 'the enemy picker needs every spawnable key');
    assert.ok(r.modes.length > 0);
    assert.ok(r.stages.some((s) => s.official) && r.stages.every((s) => s.id && s.name), 'the map picker needs id + name');
  });

  test('preview derives totalCount and slotCounts without writing', async () => {
    const r = await post(`${editor.url}/api/waves/preview`, { spec: waveSpec() }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.record.id, 'wave_ws_round_two_hounds');
    assert.equal(r.record.totalCount, 5, 'the unharmful spawn does not count toward the total');
    assert.deepEqual(r.record.slotCounts, { N: 2, NF: 1, E: 3 }, 'but it DOES count into its slot');
    assert.equal(fs.existsSync(join(wsRoot, 'wave-pack')), false, 'a preview must not write');
  });

  test('saving writes the spec and the generated record; deleting removes them', async () => {
    const saved = await post(`${editor.url}/api/packs/wave-pack/waves`, { spec: waveSpec() }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.id, 'wave_ws_round_two_hounds');
    const packDir = join(wsRoot, 'wave-pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir, 'pack.json'), 'utf8')).content, ['waves']);
    assert.equal(fs.existsSync(join(packDir, 'wave-specs/round_two_hounds.json')), true, 'the spec is the editable source');
    const records = JSON.parse(fs.readFileSync(join(packDir, 'waves.json'), 'utf8'));
    assert.equal(records.wave_ws_round_two_hounds.totalCount, 5);

    const listed = await fetch(`${editor.url}/api/waves`).then((x) => x.json());
    const found = listed.waves.find((w) => w.id === 'wave_ws_round_two_hounds');
    assert.ok(found && found.managed, 'the timeline must be able to reopen what it wrote');
    assert.equal(found.spawns, 3);
    assert.equal(found.routes, 1);
    assert.deepEqual(found.issues.filter((i) => i.severity === 'error'), []);
    assert.deepEqual(found.modeRounds, ['mode_multi_normal#2']);

    const del = await fetch(`${editor.url}/api/packs/wave-pack/waves/wave_ws_round_two_hounds`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(join(packDir, 'waves.json'), 'utf8')).wave_ws_round_two_hounds, undefined);
  });

  test('a spawn naming an enemy nothing defines is refused (it would silently spawn nothing)', async () => {
    const bad = await post(`${editor.url}/api/packs/wave-pack/waves`, { spec: { ...waveSpec(), spawns: [{ time: 1, key: 'enemy_typo', count: 1, interval: 0, routeIndex: 0 }] } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'UNKNOWN_ENEMY'));
  });

  test('a routeIndex past the wave routes is refused (the sim would silently walk route 0)', async () => {
    const bad = await post(`${editor.url}/api/packs/wave-pack/waves`, { spec: { ...waveSpec(), spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0, routeIndex: 7 }] } });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.some((e) => e.code === 'ROUTE_MISSING'));
  });

  test('a typo in a spawn field is refused rather than silently dropped', async () => {
    const bad = await post(`${editor.url}/api/waves/preview`, { spec: { ...waveSpec(), spawns: [{ time: 1, key: 'enemy_1007_slime', count: 1, interval: 0, sleot: 'N' }] } }).then((x) => x.json());
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'UNKNOWN_FIELD' && e.field === 'spawns[0].sleot'), JSON.stringify(bad.errors));
  });

  test('the timeline page is part of the editor, and only of the editor', async () => {
    const html = await fetch(`${editor.url}/wave.html`).then((r) => r.text());
    assert.match(html, /工坊出怪设计器/);
    assert.equal((await fetch(`${editor.url}/wave.js`)).status, 200);
  });
});

describe('workshop editor: the 3D preview mounts (read-only, and narrow)', () => {
  test('the game modules, three.js, the manifest and the board art are served', async () => {
    for (const [p, type] of [
      ['/client/js/render/board3d/load.js', /javascript/],
      ['/client/js/render/board3d/scene.js', /javascript/],
      ['/client/js/render/projection.js', /javascript/],
      ['/vendor/three.module.js', /javascript/],
      ['/data/local-assets.json', /application\/json/],
    ]) {
      const r = await fetch(`${editor.url}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type') || '', type, p);
    }
    // the client module must be the real one, not a stub: the preview imports this exact file
    const load = await fetch(`${editor.url}/client/js/render/board3d/load.js`).then((r) => r.text());
    assert.match(load, /export function loadBoardPack/);
    assert.match(load, /export function webgl2Available/);
  });

  test('the board art is served when this machine has it, and its absence is not an error', async () => {
    // the manifest is the source of truth for whether the 3D preview can work at all; on a host with no local-client
    // extraction the file is simply absent and the editor stays on the 2D canvas
    const manifestRes = await fetch(`${editor.url}/data/local-assets.json`);
    const manifest = manifestRes.status === 200 ? await manifestRes.json() : null;
    if (!manifest) {
      // no art on this machine: the editor must still serve its own pages (the fallback path)
      assert.equal((await fetch(`${editor.url}/stage.html`)).status, 200);
      return;
    }
    const entry = manifest.groups?.['map/autochess']?.TX_autochessi_D;
    if (!entry?.path) return; // listed differently: nothing to assert about the art itself
    const art = await fetch(`${editor.url}${entry.path}`);
    assert.equal(art.status, 200, entry.path);
    // 本机素材里的棋盘图集可能是 png，也可能是官方 0.2.0 压过的 webp（data/local-assets.json 的 path 说了算）
    assert.match(art.headers.get('content-type') || '', /image\/(png|webp)/);
    assert.ok(Number(art.headers.get('content-length')) > 1000, 'the atlas must be real bytes');
  });

  test('percent-encoded 贴图名必须解码（否则 3D 预览静默全黑）', async () => {
    // 业主实测「点 3D 全黑」的根因就在这条：官方棋盘图集里有两张文件名带方括号的贴图，浏览器发的是
    // `%5Bopt%5D…`，而编辑器过去拿这段编码直接去查文件 → 404 → 棋盘建不出来 → 画布全黑且不报错。
    // 这两条断言就是那两张贴图；换机器上没有本机素材时它们不存在，跳过（此时 3D 本来就退回 2D）。
    const withBrackets = [
      '/assets/local/map/fx/%5Bopt%5Dmerged_textures.png',
      '/assets/local/map/water/%5Bucp%5DTX_water_normal.png',
    ];
    let checked = 0;
    for (const url of withBrackets) {
      const res = await fetch(`${editor.url}${url}`);
      if (res.status === 404) continue;                    // 本机没提取过这两张素材
      assert.equal(res.status, 200, `${url} 必须能取到（编码后的文件名要解码）`);
      assert.match(res.headers.get('content-type') || '', /image\/png/);
      const bytes = Buffer.from(await res.arrayBuffer());
      const onDisk = join(ROOT, 'public', decodeURIComponent(url.replace('/assets/', 'assets/')));
      assert.ok(bytes.length > 1000, `${url} 要是真字节`);
      if (fs.existsSync(onDisk)) assert.deepEqual(bytes, fs.readFileSync(onDisk), '取到的必须就是磁盘上那个文件');
      checked++;
    }
    if (!checked) return; // 这台机器没有本机素材：上面的遍历已经全部跳过
  });

  test('解码之后仍然挡住路径穿越（先检查后解码就会漏）', async () => {
    // 顺序：**先解码、再检查**。这几条如果按「先检查后解码」写，%2e%2e 就会骗过 `..` 的判断。
    for (const url of ['/assets/%2e%2e/package.json', '/assets/local/%2e%2e/%2e%2e/package.json',
      '/client/..%2f..%2fpackage.json', '/assets/local%2Fmap/autochess/tiles.json',
      '/assets/local/map/%2e%2e%2f%2e%2e%2fpackage.json', '/docs/%2e%2e%2fpackage.json']) {
      const res = await fetch(`${editor.url}${url}`);
      assert.ok(res.status === 404 || res.status === 403, `${url} -> ${res.status}`);
      const body = await res.text();
      assert.doesNotMatch(body, /"scripts"|"dependencies"/, `${url} 泄漏了 package.json`);
    }
  });

  test('语音试听的文件名带空格/井号也能取到（同一处解码）', async () => {
    // 编辑器页面自己发的试听 URL 就是逐段 encodeURIComponent 的：包作者的文件名里可以有空格或 `#`。
    // 不解码的话「页面上列得出来、点了播不了」，与 3D 全黑是同一类静默失败。
    const dir = join(wsRoot, 'diag-voice-pack');
    fs.mkdirSync(join(dir, 'assets', 'voice'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), JSON.stringify({ id: 'diag-voice-pack', name: '试听诊断', version: '1.0.0', license: 'CC0-1.0', content: [], voices: { char_x: { win: ['voice/a b#c.mp3'] } } }));
    fs.writeFileSync(join(dir, 'assets', 'voice', 'a b#c.mp3'), Buffer.from('ID3-diagnostic'));
    const url = `${WORKSHOP_ASSET_PREFIX}diag-voice-pack/voice/${encodeURIComponent('a b#c.mp3')}`;
    const res = await fetch(`${editor.url}${url}`);
    assert.equal(res.status, 200, url);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()).toString('latin1'), 'ID3-diagnostic');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('it is not a file server: escapes, foreign extensions and other data files are refused', async () => {
    const attempts = [
      '/client/js/render/board3d/evil.exe',
      '/client/js/render/board3d/../../../../package.json',
      '/client/../data/chess.json',
      '/assets/local/../../server/index.js',
      '/assets/local/map/autochess/tiles.js',   // a .js under assets/ is not in the art allowlist
      '/assets/local/map/autochess/.hidden.png',
      '/data/chess.json',                        // only local-assets.json is exposed, not the whole data dir
      '/data/waves.json',
      '/vendor/../server/index.js',
    ];
    for (const p of attempts) {
      const r = await fetch(`${editor.url}${p}`);
      assert.ok(r.status === 404 || r.status === 403, `${p} -> ${r.status}`);
    }
  });

  test('the 3D mounts do not shadow the editor\'s own pages', async () => {
    // `/` still serves the operator editor, and adding /client/, /vendor/, /assets/ changed nothing about it
    assert.match(await fetch(`${editor.url}/`).then((r) => r.text()), /创意工坊编辑器/);
    assert.equal((await fetch(`${editor.url}/stage.js`)).status, 200);
    assert.equal((await fetch(`${editor.url}/stage3d.js`)).status, 200);
    const html = await fetch(`${editor.url}/stage.html`).then((r) => r.text());
    assert.match(html, /id="ov3d"/, 'the placer must offer the 3D toggle');
    assert.match(html, /id="board3d"/, 'and the canvas the preview draws into');
  });

  test('3D 是地图页的默认视图（2D 地图不直观），但按钮/参数仍能退回 2D', async () => {
    const src = await fetch(`${editor.url}/stage.js`).then((r) => r.text());
    // 默认打开：`auto3d` 初始为 true，且只有 `?board=2d` 才拦住它 —— 这三种写法缺一样都会悄悄变回「要点一下才有 3D」
    assert.match(src, /auto3d: true/, '默认就要允许自动打开 3D');
    assert.match(src, /state\.board !== '2d'/, '只有 ?board=2d 能强制留在 2D');
    assert.match(src, /if \(state\.auto3d && state\.board !== '2d' && !state\.mode3d\) await toggle3d\(\)/,
      '进地图页时就自动挂上 3D 预览');
    // 作者手动切回 2D 是明确选择：自动流程不能再把它扳回 3D（否则按钮和自动逻辑互相打架）
    assert.match(src, /state\.auto3d = false/, '切回 2D 要关掉自动打开');
    // 第一帧就要有内容：先等这张地图的推导结果，再挂 3D 预览
    assert.match(src, /await preview\(\);/, '挂 3D 之前先把 preview 拿到手，否则第一帧是空棋盘');
    // `?board=3d` 的旧约定仍然有效（与 `2d` 同一个参数解析），并且不再需要特殊分支
    assert.match(src, /new URLSearchParams\(location\.search\)\.get\('board'\)/, '沿用游戏客户端的 ?board= 约定');
  });

  test('the 3D module states its four availability checks and falls back instead of throwing', async () => {
    const src = await fetch(`${editor.url}/stage3d.js`).then((r) => r.text());
    for (const probe of ['boardArtListed', 'webgl2Available', 'loadThree', 'loadBoardPack']) {
      assert.match(src, new RegExp(probe), `stage3d.js must check ${probe}`);
    }
    assert.match(src, /ok: false, reason/, 'every failure must produce a reason, not an exception');
    assert.match(src, /已退回 2D/, 'and the reason must say it stayed on 2D');
    // it reuses the game's renderer rather than re-drawing the board
    assert.match(src, /board3d\/scene\.js/, 'must use the game BoardScene');
    assert.match(src, /render\/projection\.js/, 'must use the game camera');
    assert.doesNotMatch(src, /new THREE\.BoxGeometry|buildBoard\(/, 'must not re-implement the board geometry');
  });

  test('the four scene settings that each silently render a broken preview are present', async () => {
    // Every one of these was found by rendering a real map and reading the frame back. Each failure mode is silent
    // (the canvas just looks black or half-empty), so they are asserted rather than left to the next reader to rediscover.
    const src = await fetch(`${editor.url}/stage3d.js`).then((r) => r.text());
    // 1. BoardScene builds only the tiles inside its current `area`; the default is a PARTIAL map (137 of 399 tiles)
    assert.match(src, /setArea\(AREAS\.all\)/, 'must build the whole board (AREAS.all), not the default partial area');
    // 2. everything outside the focus rect is dimmed to 28% — without this the board is nearly black
    assert.match(src, /setFocus\(null\)/, 'must light the whole board (setFocus(null) = everything lit)');
    // 3. the scene fogs 17→36 into a near-black colour, tuned for the game\'s ~16-unit camera
    assert.match(src, /fog\.near\s*=/, 'must push the battle fog past the overview distance');
    // 4. cx/cy are the camera\'s screen centre in px; leaving them at 0 shifts the view half a screen and the board
    //    ends up in a corner of an otherwise empty canvas
    assert.match(src, /cam\.cx\s*=\s*cssW\s*\/\s*2/, 'must centre the view offset (cx) on the canvas');
    assert.match(src, /cam\.cy\s*=\s*cssH\s*\/\s*2/, 'must centre the view offset (cy) on the canvas');
    // and the framing is derived from what the board actually built, never from assumed tile coordinates
    assert.match(src, /board\?\.bounds/, 'must frame from the built board\'s bounds');
  });

  test('the 3D view exposes named framings, and the page renders a button for each', async () => {
    const src = await fetch(`${editor.url}/stage3d.js`).then((r) => r.text());
    // a known view is just (tilt, dist) + target, so it is data — and the UI must build its buttons from that data
    assert.match(src, /preset\(name\)/, 'the view exposes preset(name)');
    assert.match(src, /presets:\s*\(\)\s*=>/, 'and lists them for the UI to render');
    for (const id of ['overview', 'top', 'game', 'low', 'close']) {
      assert.match(src, new RegExp(`id: '${id}'`), `the ${id} framing must exist`);
    }
    // "the framing players actually get" must come from the project's own optics, not a restated number that can drift
    assert.match(src, /DEFAULT_OPTICS/, 'the game framing must use the project\'s DEFAULT_OPTICS');
    assert.doesNotMatch(src, /id: 'game', tilt: \d/, 'the game framing must not hardcode a tilt');
    // the page has somewhere to put them, and stage.js fills it from the view rather than a duplicated list
    const html = await fetch(`${editor.url}/stage.html`).then((r) => r.text());
    assert.match(html, /id="presets3d"/, 'stage.html needs the preset row');
    const page = await fetch(`${editor.url}/stage.js`).then((r) => r.text());
    assert.match(page, /presets3d/, 'stage.js must fill the preset row');
    assert.match(page, /view\.presets\(\)/, 'from view.presets(), so the buttons cannot list a framing that does not exist');
  });

  test('「显示寻路」那层要有数据可画：preview 按开关请求寻路表，开关打开时重新取一次', async () => {
    // 这一层画的是**推导出来的寻路表**（draw() 里的 rec.groundPaths），而那张表只有请求时服务端才算
    // （opts.paths；官方图自带表，工坊图没有）。此前 preview 从不请求它 ⇒ 开关打开也永远一条线都没有 ——
    // 业主在 0.9.2 的大图上点「自动寻路」（它顺手把开关打开）看到的就是这个：按钮态正常，画布上没线。
    const src = await fetch(`${editor.url}/stage.js`).then((r) => r.text());
    assert.match(src, /paths: state\.showPaths === true/, 'preview 要按「显示寻路」开关请求寻路表');
    assert.match(src, /#ovPaths'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,240}?if \(state\.showPaths\) void preview\(\); else draw\(\);/,
      '开关打开时要重新取一次表（表是请求时才有的）');
    // 关着的时候不要请求：每次编辑都多算一遍流场不值当
    assert.match(src, /if \(state\.showPaths\) void preview\(\); else draw\(\)/, '关掉时只重画');
  });
});
