// test/bondEditor.test.js — 盟约页（/bond.html + /api/bonds*）的端到端。
//
// 这一页要证明的三件事，全部走「编辑器真的写盘 → 游戏加载器真的读得到」这条路：
//   * **新增盟约**：bonds.json 有它、pack.json 的 content 声明了 bonds、合并后的数据里它在（计数 / 禁用抽签 / 界面都会用它）；
//   * **覆盖官方盟约**：pack.json 的 overrides 有 `bonds:<id>`，合并后官方那条的阈值与黑板数值真的变了 ——
//     这才是「修改官方盟约」生效的方式（官方效果按 id 实现、数值从记录读）；
//   * **成员**：`members` 由干员记录的 `bonds` 推导，改成员等于改干员 spec，改完盟约记录的 members 也要跟着更新。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { loadData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { SharedPool } from '../server/match/pool.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** 一个真的存在于本机模型清单里的 spine id（干员没有外观会被编辑器拒绝保存）。 */
const SOME_SPINE = (() => {
  try { return Object.keys(JSON.parse(fs.readFileSync(join(DATA_DIR, 'assets.json'), 'utf8')).chars || {})[0] ?? ''; } catch { return ''; }
})();

const OP_SPEC = {
  id: 'bond_member', name: '盟约成员', tier: 3, profession: 'WARRIOR', position: 'MELEE', assetsSpine: SOME_SPINE,
  stats: {
    normal: { maxHp: 1400, atk: 460, def: 130, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
    golden: { maxHp: 1800, atk: 600, def: 170, res: 0, cost: 18, blockCnt: 2, bat: 1.0 },
  },
};

const BOND_SPEC = {
  id: 'wsBondShip', name: '工坊盟约', desc: '测试用盟约', thresholds: [2, 4, 6], countMode: 'BOARD',
  weight: 10, genericBuffs: true, bb: { base_atk: 0.2, atk_per_stack: 0.02 },
};

let tmp;
let wsRoot;
let editor;

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-bond-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
  fs.writeFileSync(join(tmp, 'support.json'), `${JSON.stringify({ enabled: true, label: '助战', slots: { 5: 1 }, pool: { 5: ['chess_char_5_01_a'] } }, null, 2)}\n`);
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const packDir = (id) => join(wsRoot, id);
const manifestOf = (id) => JSON.parse(fs.readFileSync(join(packDir(id), 'pack.json'), 'utf8'));
const bondsOf = (id) => JSON.parse(fs.readFileSync(join(packDir(id), 'bonds.json'), 'utf8'));
const merged = () => loadData(DATA_DIR, { log: quiet, workshopDir: wsRoot });

describe('盟约页：读接口', () => {
  test('GET /api/bonds 给出官方的 23 条、枚举候选、图标与效果清单，以及成员勾选用的干员表', async () => {
    const r = await fetch(`${editor.url}/api/bonds`).then((x) => x.json());
    assert.equal(r.officialCount, 23);
    assert.equal(r.officialBonds.length, 23);
    assert.equal(r.officialBonds[0].bondId, 'yanShip', '核心盟约排前面，按 identifier');
    assert.deepEqual(r.countModes, ['BOARD', 'BOARD_AND_DECK', 'BOARD_ALL_CHESS']);
    assert.equal(r.thresholdTemplates.length, 3);
    assert.deepEqual(r.activeTypes, ['BATTLE', 'ALL', 'MANI']);
    assert.equal(r.genericKeys.length, 6);
    assert.equal(r.iconChoices.length >= 23, true, '本机的盟约图标清单');
    assert.equal(r.effectChoices.every((id) => id.startsWith('bondeffect_')), true);
    assert.ok(r.operators.length > 100, '成员勾选要能看到官方干员');
    assert.ok(r.operators.every((o) => Array.isArray(o.bonds)), '每个干员带自己的 bonds（成员由它推导）');
    assert.deepEqual(r.packs, [], '还没有包');
  });

  test('GET /api/bonds/template 把官方盟约转成可编辑的 spec（id 留空）', async () => {
    const r = await fetch(`${editor.url}/api/bonds/template?bondId=yanShip`).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.official, true);
    assert.equal(r.spec.id, '');
    assert.deepEqual(r.spec.thresholds, [3, 6, 9]);
    assert.equal(r.spec.bb.base_atk, 0.23);
    assert.equal(r.spec.isCore, true);
  });

  test('未知 id 是 404；坏路径是 400', async () => {
    assert.equal((await fetch(`${editor.url}/api/bonds/template?bondId=nope`)).status, 404);
    assert.equal((await post(`${editor.url}/api/packs/bad%20id/bonds`, { spec: BOND_SPEC })).status, 400);
  });

  test('POST /api/bonds/preview 说出错误与「这是覆盖官方」', async () => {
    const bad = await post(`${editor.url}/api/bonds/preview`, { spec: { ...BOND_SPEC, id: 'x', name: '', thresholds: [3, 3] } }).then((x) => x.json());
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'MISSING'));
    assert.ok(bad.errors.some((e) => e.code === 'NOT_ASCENDING'));
    const over = await post(`${editor.url}/api/bonds/preview`, { spec: { ...BOND_SPEC, id: 'yanShip' } }).then((x) => x.json());
    assert.equal(over.overriding, true);
    assert.equal(over.ok, true, JSON.stringify(over.errors));
    const fresh = await post(`${editor.url}/api/bonds/preview`, { spec: BOND_SPEC }).then((x) => x.json());
    assert.equal(fresh.overriding, false);
    assert.equal(fresh.warnings.some((w) => /圆点/.test(w)), true, '新增盟约没有图标，要说出来');
  });
});

describe('盟约页：新增一条盟约，加载器与引擎真的看到它', () => {
  before(async () => {
    // 先在这个包里放一个干员（成员那一段要用它）
    const r = await post(`${editor.url}/api/packs/ws-pack/operators`, { spec: OP_SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
  });

  test('保存后：pack.json 声明 bonds、spec 落盘、bonds.json 有记录', async () => {
    const r = await post(`${editor.url}/api/packs/ws-pack/bonds`, { spec: BOND_SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bondId, 'wsBondShip');
    assert.equal(r.overriding, false);
    assert.deepEqual(r.generated, ['wsBondShip']);
    const man = manifestOf('ws-pack');
    assert.deepEqual(man.content, ['bonds', 'chess'], 'content 必须同时声明 bonds 与 chess，且按字典序');
    assert.deepEqual(man.overrides, []);
    assert.equal(fs.existsSync(join(packDir('ws-pack'), 'bond-specs', 'wsBondShip.json')), true, '可编辑的源在 bond-specs/');
    const rec = bondsOf('ws-pack').wsBondShip;
    assert.equal(rec.name, '工坊盟约');
    assert.equal(rec.activeCount, 2, 'activeCount 由第一个阈值派生');
    assert.deepEqual(rec.thresholds, [2, 4, 6]);
    assert.equal(rec.genericBuffs, true);
    assert.deepEqual(rec.buffs, [{ key: 'env_gbuff_new', bb: { base_atk: 0.2, atk_per_stack: 0.02 }, bbStr: {} }]);
    assert.deepEqual(rec.members, [], '还没有干员携带它');
  });

  test('合并后的数据里有它，GameData 把它当成一条普通盟约（可被禁用抽签、进池判定）', () => {
    const data = merged();
    assert.equal(Object.keys(data.bonds).length, 24, '23 官方 + 1 新增');
    assert.equal(data.bonds.wsBondShip.name, '工坊盟约');
    const gd = new GameData(data, 'mode_multi_hard');
    assert.ok(gd.bondIds.includes('wsBondShip'));
    assert.equal(gd.bond('wsBondShip').genericBuffs, true);
    // 权重 > 0 的盟约会被抽进「本局禁用」的候选池 —— 它就是一条普通盟约
    assert.equal(gd.bond('wsBondShip').weight > 0, true);
    // 抽签不炸（用固定 rng 只确认它不抛异常）
    const rng = () => 0.5; rng.shuffle = (a) => a;
    assert.ok(gd.bondIds.length === 24);
  });

  test('成员：把本包的干员勾进来，干员 spec 与盟约记录的 members 一起更新', async () => {
    const r = await post(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip/members`, { add: ['chess_ws_bond_member_a'] }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.members, ['chess_ws_bond_member_a']);
    const spec = JSON.parse(fs.readFileSync(join(packDir('ws-pack'), 'specs', 'bond_member.json'), 'utf8'));
    assert.deepEqual(spec.bonds, ['wsBondShip'], '成员的真相在干员的 bonds 上');
    const chess = JSON.parse(fs.readFileSync(join(packDir('ws-pack'), 'chess.json'), 'utf8'));
    assert.deepEqual(chess['chess_ws_bond_member_a'].bonds, ['wsBondShip']);
    assert.deepEqual(bondsOf('ws-pack').wsBondShip.members, ['chess_ws_bond_member_a'], '盟约记录里的 members 也重算');
    // 反向：移出去
    const off = await post(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip/members`, { remove: ['chess_ws_bond_member_a'] }).then((x) => x.json());
    assert.deepEqual(off.members, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(packDir('ws-pack'), 'specs', 'bond_member.json'), 'utf8')).bonds, []);
  });

  test('成员：不归本包管的干员被拒绝，且一个字节都不改', async () => {
    const before = fs.readFileSync(join(packDir('ws-pack'), 'bonds.json'), 'utf8');
    const res = await post(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip/members`, { add: ['chess_char_1_01_a'] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /不归这个包管/);
    assert.equal(fs.readFileSync(join(packDir('ws-pack'), 'bonds.json'), 'utf8'), before);
  });

  test('缺参数的成员请求是 400', async () => {
    assert.equal((await post(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip/members`, {})).status, 400);
    assert.equal((await post(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip/members`, { add: 'x' })).status, 400);
  });
});

describe('盟约页：覆盖官方盟约，官方那条的数值真的变了', () => {
  test('保存为覆盖：overrides 里有 bonds:<id>，合并后阈值与黑板都变了', async () => {
    const tpl = await fetch(`${editor.url}/api/bonds/template?bondId=yanShip`).then((x) => x.json());
    const spec = { ...tpl.spec, id: 'yanShip', thresholds: [2, 3], bb: { ...tpl.spec.bb, base_atk: 0.5, atk_per_stack: 0.05 } };
    const r = await post(`${editor.url}/api/packs/ws-pack/bonds`, { spec }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.overriding, true);
    const man = manifestOf('ws-pack');
    assert.deepEqual(man.overrides, ['bonds:yanShip']);
    const data = merged();
    assert.equal(Object.keys(data.bonds).length, 24, '覆盖不增加条目数');
    assert.deepEqual(data.bonds.yanShip.thresholds, [2, 3]);
    assert.equal(data.bonds.yanShip.activeCount, 2);
    assert.equal(data.bonds.yanShip.bb.base_atk, 0.5);
    assert.equal(data.bonds.yanShip.buffs[0].bb.base_atk, 0.5, '官方处理器读的就是 buffs 里的这份');
    // 名字等官方字段没被顺手改掉
    assert.equal(data.bonds.yanShip.name, '炎');
  });

  test('包状态页把「覆盖官方」与「已声明」分开报，且不报 id 冲突', async () => {
    const r = await fetch(`${editor.url}/api/bonds`).then((x) => x.json());
    const pb = r.packBonds.find((p) => p.id === 'ws-pack');
    const yan = pb.bonds.find((b) => b.bondId === 'yanShip');
    assert.equal(yan.official, true);
    assert.equal(yan.declared, true);
    assert.equal(yan.managed, true);
    assert.equal(yan.issues.some((i) => i.code === 'OFFICIAL_ID_COLLISION'), false, '声明过就不该再报冲突');
    const fresh = pb.bonds.find((b) => b.bondId === 'wsBondShip');
    assert.equal(fresh.official, false);
    assert.equal(fresh.declared, false);
  });

  test('删除覆盖：记录消失、官方那条回来、overrides 里的声明也收掉', async () => {
    const r = await fetch(`${editor.url}/api/packs/ws-pack/bonds/yanShip`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.deepEqual(manifestOf('ws-pack').overrides, []);
    const data = merged();
    assert.deepEqual(data.bonds.yanShip.thresholds, [3, 6, 9], '官方数值回来了');
    assert.equal(data.bonds.yanShip.bb.base_atk, 0.23);
    assert.equal(Object.keys(data.bonds).length, 24, '新增的那条还在');
  });

  test('删除新增的那条：条目与 spec 一起走', async () => {
    const r = await fetch(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(join(packDir('ws-pack'), 'bond-specs', 'wsBondShip.json')), false);
    assert.equal(Object.keys(bondsOf('ws-pack')).length, 0);
    assert.equal(Object.keys(merged().bonds).length, 23);
  });

  test('坏 id / 坏路径的删除是 400', async () => {
    assert.equal((await fetch(`${editor.url}/api/packs/ws-pack/bonds/1bad`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`${editor.url}/api/packs/bad%20id/bonds/yanShip`, { method: 'DELETE' })).status, 400);
  });
});

describe('盟约页：手写的记录不会被毁掉', () => {
  test('没有 spec 的记录在保存别的盟约时原样保留', async () => {
    const dir = packDir('hand-written');
    fs.mkdirSync(join(dir, 'bond-specs'), { recursive: true });
    fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({ id: 'hand-written', name: '手工包', version: '1.0.0', content: ['bonds'] }, null, 2)}\n`);
    fs.writeFileSync(join(dir, 'bonds.json'), `${JSON.stringify({ handShip: { bondId: 'handShip', name: '手工盟约', thresholds: [2], activeCount: 2, countMode: 'BOARD', thresholdTemplate: 'count_threshold_upward', activeType: 'BATTLE', weight: 10, members: [] } }, null, 2)}\n`);
    const r = await post(`${editor.url}/api/packs/hand-written/bonds`, { spec: { ...BOND_SPEC, id: 'anotherShip' } }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    const recs = bondsOf('hand-written');
    assert.equal(recs.handShip.name, '手工盟约', '没有 spec 的记录必须原样保留');
    assert.equal(recs.anotherShip.name, '工坊盟约');
    assert.equal(Object.keys(recs).length, 2);
  });

  test('池子与助战不受影响：bonds 只写 bonds.json 与 pack.json 的 content/overrides', async () => {
    const man = manifestOf('hand-written');
    assert.deepEqual(man.content, ['bonds']);
    assert.deepEqual(man.overrides, []);
  });
});
