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

describe('盟约页：本包自带的图标（pack.json 的 bondIcons）', () => {
  const ICON_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452STANDIN', 'latin1');
  let pngPath;

  before(async () => {
    // 重新建一条本包的盟约（前面的用例把它删掉了），并把一张图放进 assets/
    const r = await post(`${editor.url}/api/packs/ws-pack/bonds`, { spec: BOND_SPEC }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    // 有 assets/ 的包必须声明 license（shared/workshop.js 的 ASSETS_NEED_LICENSE），先补上再放文件
    const man = manifestOf('ws-pack');
    fs.writeFileSync(join(packDir('ws-pack'), 'pack.json'), `${JSON.stringify({ ...man, license: 'CC0-1.0' }, null, 2)}\n`);
    pngPath = join(packDir('ws-pack'), 'assets', 'bond', 'wsBondShip.png');
    fs.mkdirSync(join(packDir('ws-pack'), 'assets', 'bond'), { recursive: true });
    fs.writeFileSync(pngPath, ICON_PNG);
  });

  test('GET /api/bonds 把本包的图片列出来，并带上当前声明', async () => {
    const r = await fetch(`${editor.url}/api/bonds`).then((x) => x.json());
    const pb = r.packBonds.find((p) => p.id === 'ws-pack');
    assert.deepEqual(pb.iconFiles, ['bond/wsBondShip.png'], '只列真的能当图标画的文件');
    assert.deepEqual(pb.bondIcons, {}, '还没配');
  });

  test('保存图标：写进 pack.json 的 bondIcons，加载器把它并进 assets.bonds', async () => {
    const r = await post(`${editor.url}/api/packs/ws-pack/bond-icons`, { bondId: 'wsBondShip', path: 'bond/wsBondShip.png' }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, 'bond/wsBondShip.png');
    assert.deepEqual(manifestOf('ws-pack').bondIcons, { wsBondShip: 'bond/wsBondShip.png' });
    const data = merged();
    assert.equal(data.assets.bonds.wsBondShip, '/workshop-assets/ws-pack/bond/wsBondShip.png');
    assert.equal(data.assets.bonds.yanShip, '/assets/bond/yanShip.png', '官方图标照旧');
  });

  test('清空（path 为空）＝删掉这条声明，assets.bonds 里那一条也回去', async () => {
    const r = await post(`${editor.url}/api/packs/ws-pack/bond-icons`, { bondId: 'wsBondShip', path: '' }).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.equal(r.path, null);
    assert.equal('bondIcons' in manifestOf('ws-pack'), false, '空对象不留在 pack.json 里');
    assert.equal('wsBondShip' in merged().assets.bonds, false);
  });

  test('每一种坏请求都是 400，而且一个字节都不写', async () => {
    const before = JSON.stringify(manifestOf('ws-pack'));
    const cases = [
      [{ bondId: 'wsBondShip', path: '../secret.png' }, '路径穿越'],
      [{ bondId: 'wsBondShip', path: '/abs.png' }, '绝对路径'],
      [{ bondId: 'wsBondShip', path: 'bond/nope.png' }, '文件不存在'],
      [{ bondId: 'wsBondShip', path: 'bond/wsBondShip.txt' }, '不是图片'],
      [{ bondId: 'bad id!', path: 'bond/wsBondShip.png' }, '坏 id'],
      [{ bondId: 'notInPack', path: 'bond/wsBondShip.png' }, '这个包没有这条盟约'],
    ];
    for (const [body, why] of cases) {
      const res = await post(`${editor.url}/api/packs/ws-pack/bond-icons`, body);
      assert.equal(res.status, 400, `${why} 应该被拒`);
    }
    assert.equal(JSON.stringify(manifestOf('ws-pack')), before, '被拒之后 pack.json 必须一个字节都没变');
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

// 「本包已声明的图标」清单：上面那一段只认当前盟约 id，所以作者删掉（或改名成新 id）一条盟约之后，`pack.json` 里
// `bondIcons[旧 id]` 那条声明在页面上再也看不到、也删不掉 —— 只能手改清单。这组用例钉住清单赖以工作的那份状态
// （**原样读出**的全部声明，含陈旧条目）、能删的那条路（还在用的 id），以及**陈旧声明的清空**那条路
// （曾经被 `editor/server.mjs` 的 bond-icons 分支挡住：存在性检查在算 `clearing` 之前；现已挪进非清空分支）。
describe('盟约页：本包已声明的图标清单（含陈旧条目）', () => {
  // 图标文件用上一组用例已经放进 assets/ 的那张图（内容无所谓，路径与声明才是这里要证的东西）
  const ICON_PATH = 'bond/wsBondShip.png';
  const listed = () => fetch(`${editor.url}/api/bonds`).then((x) => x.json()).then((r) => r.packBonds.find((p) => p.id === 'ws-pack'));
  const setIcon = (bondId, path) => post(`${editor.url}/api/packs/ws-pack/bond-icons`, { bondId, path });

  before(async () => {
    // 前面的用例把图标清掉了：这里重新声明一条，并保证那条盟约记录在（「有人在用」就是按它算的）
    const saved = await post(`${editor.url}/api/packs/ws-pack/bonds`, { spec: BOND_SPEC }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const declared = await setIcon('wsBondShip', ICON_PATH).then((x) => x.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
  });

  test('删掉那条盟约之后，这条声明还在状态里：页面拿到的就是含陈旧条目的那一份', async () => {
    const del = await fetch(`${editor.url}/api/packs/ws-pack/bonds/wsBondShip`, { method: 'DELETE' }).then((x) => x.json());
    assert.equal(del.ok, true, JSON.stringify(del));
    const pb = await listed();
    assert.equal(pb.bondIcons.wsBondShip, ICON_PATH, '陈旧声明必须原样给页面（清单列的就是这一份）');
    assert.equal(pb.bonds.some((b) => b.bondId === 'wsBondShip'), false,
      '本包已经没有这条盟约 —— 页面据此把它标成「陈旧 / 没人用」');
    assert.equal(merged().assets.bonds.wsBondShip, `/workshop-assets/ws-pack/${ICON_PATH}`,
      '没删之前这条声明仍然生效（那正是它必须能被删掉的理由）');
  });

  test('删掉陈旧声明：配图被拒、清空放行，pack.json 与 assets.bonds 里那条一起回去', async () => {
    // 「只收本包有的盟约」拦的是配图 —— 给一条陈旧声明重新配图是 400，而清空是例外：它正是修掉陈旧声明的方式
    assert.equal((await setIcon('wsBondShip', ICON_PATH)).status, 400, '本包没有这条盟约就不能再配图');
    const r = await setIcon('wsBondShip', '').then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, null);
    assert.equal('bondIcons' in manifestOf('ws-pack'), false, '空对象不留在 pack.json 里');
    assert.equal('wsBondShip' in merged().assets.bonds, false, '合并后的 assets.bonds 里那条也回去了');
  });

  test('删除一个还在用的 id 同样能删（清空不受「只收本包有的盟约」限制）', async () => {
    const saved = await post(`${editor.url}/api/packs/ws-pack/bonds`, { spec: BOND_SPEC }).then((x) => x.json());
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const declared = await setIcon('wsBondShip', ICON_PATH).then((x) => x.json());
    assert.equal(declared.ok, true, JSON.stringify(declared));
    assert.equal(merged().assets.bonds.wsBondShip, `/workshop-assets/ws-pack/${ICON_PATH}`);
    // 页面上它显示为「有人在用」（本包 bonds.json 里还有这条盟约），删除走的是同一条空 path
    const r = await setIcon('wsBondShip', '').then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal('wsBondShip' in (manifestOf('ws-pack').bondIcons ?? {}), false);
    assert.equal('wsBondShip' in merged().assets.bonds, false);
  });

  test('页面：清单遍历的是全部声明，每条一个走空 path 的删除入口（源码层面钉住这条出口）', async () => {
    const src = fs.readFileSync(join(ROOT, 'editor/ui/bond.js'), 'utf8');
    assert.match(src, /本包已声明的盟约图标/, '清单要有标题');
    assert.match(src, /Object\.entries\(packState\?\.bondIcons \?\? \{\}\)/, '要遍历全部声明，不是只列当前盟约 id 那一条');
    const fn = src.slice(src.indexOf('async function deleteDeclaredBondIcon'));
    assert.ok(fn, '清单的删除要有自己的入口');
    assert.match(fn.slice(0, 1200), /\/bond-icons`/, '删除走 bond-icons');
    assert.match(fn.slice(0, 1200), /path: ''/, '空 path 才是「删掉这条声明」');
  });
});

// 顺手修掉的两处旧缺陷，都在本次改动的 editor/ui/bond.js 里，且都会让「本包已声明的图标」那块所在的**那张表单**
// 或**那条回执**失效，所以值得钉住（真浏览器里都是当场可见的，见报告）：
//   * `textInput` 把 attrs 整个 `Object.assign` 到 input 上 —— `list` 在 HTMLInputElement 上是只读访问器，会抛
//     「Cannot set property list」；而它抛在表单绘制的中途：这一行之后的「战斗数值（黑板 bb）」与「成员」两整段
//     再也不画出来（`Object.assign(i, attrs)` 在 HEAD 里就这么写）。
//   * `h()` 只认 `class`，可本页的调用大量写的是 `className`（连它的文档注释也这么写）—— 那些类名掉进
//     `setAttribute`，变成一条叫 "className" 的属性，CSS 不认：横幅、hint、tag 全都没有样式（回执因此看不出是回执）。
describe('盟约页：表单绘制不被打断（本次顺手修的两处旧缺陷）', () => {
  const src = () => fs.readFileSync(join(ROOT, 'editor/ui/bond.js'), 'utf8');

  test('datalist 的 list 走 setAttribute，不再被 Object.assign 抛断', () => {
    const text = src();
    // `list` 是只读访问器：把整个 attrs Object.assign 到 input 上会抛，而抛点之后的表单就不画了
    assert.match(text, /const \{ list, \.\.\.rest \} = attrs;/, '`list` 要从 attrs 里摘出来');
    assert.match(text, /if \(list\) i\.setAttribute\('list', list\);/, '摘出来的 list 走 setAttribute');
  });

  test('h() 认得本页在用的两种 class 拼法', () => {
    assert.match(src(), /k === 'class' \|\| k === 'className'/, '横幅 / hint / tag 的样式靠它');
  });
});
