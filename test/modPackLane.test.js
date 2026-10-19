// test/modPackLane.test.js — DESIGN §28.56：包声明的 WebSocket lane。
// 两半各自钉住：形状层（pack.json 里那句声明的每条拒绝码）与纯的那半（`server/modLanes.js` 的认领 / 撞车 /
// 限额 / 「处理器还没就位」）。这一格最怕的失败方向是「包合法、表里没这行、客户端连过去永远没反应」，
// 所以每一条都判它响不响。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackManifest, SERVER_MODULE_USES } from '../shared/workshop.js';
import { claimPackLane, attachPackLaneHandler, packLaneTable, packLaneRows, clearPackLanes, } from '../server/modLanes.js';
import { isLanePath, MAX_WS_LANES } from '../server/http/wsLanes.js';

const mk = (modules) => normalizePackManifest({ id: 'p', name: 'p', content: ['chess'], server: { modules } }, 'p');
const LANE_OK = { id: 'm', entry: 'server/m.mjs', uses: ['lane'], lane: { path: '/mod-ws/p/duel' } };

beforeEach(() => clearPackLanes());

test('lane 是闭枚举里的一格，且加在末尾 ⇒ 现存包的 uses 字节不变', () => {
  assert.deepEqual([...SERVER_MODULE_USES], ['boot', 'shutdown', 'matchClass', 'healthz', 'metrics', 'route', 'lane']);
});

describe('形状层：每条失败都点名', () => {
  test('合法声明：lane 进归一化清单，只在声明时才有这个键', () => {
    const ok = mk([LANE_OK]);
    assert.equal(ok.ok, true, JSON.stringify(ok.detail));
    assert.deepEqual(ok.pack.server.modules[0].lane, { path: '/mod-ws/p/duel' });
    const bare = mk([{ id: 'm', entry: 'server/m.mjs', uses: ['healthz'] }]);
    assert.equal(bare.ok, true, JSON.stringify(bare.detail));
    assert.ok(!Object.hasOwn(bare.pack.server.modules[0], 'lane'));
  });

  test('未声明 lane 的老包：整条 server.modules[] 条目与改动前 deepEqual（逐字不变）', () => {
    // 闭枚举扩张（`SERVER_MODULE_USES` 6→7、`SERVER_MODULE_FIELDS` 5→6）**必须**带的那一条判据。
    // 比上面那条强：上面只问 `lane` 在不在，这一条把**整条模块条目**钉成一份完整期望值 ——
    // 多一个键、少一个键、键序变了都当场红。为什么必须这么严：`identifyPack` 哈希的就是这份归一化清单的
    // canonicalJson，给每个模块都补一个 `lane: null` 会让**所有已发布包**的摘要全部改变（DESIGN §28.2）。
    const bare = mk([{ id: 'm', entry: 'server/m.mjs', uses: ['healthz'] }]);
    assert.equal(bare.ok, true, JSON.stringify(bare.detail));
    assert.deepEqual(bare.pack.server.modules, [{ id: 'm', entry: 'server/m.mjs', uses: ['healthz'], write: false }]);
  });

  test('summary 写了才进清单，且字段顺序固定', () => {
    const ok = mk([{ ...LANE_OK, lane: { path: '/mod-ws/p/duel', summary: '足球 3v3 中继' } }]);
    assert.equal(ok.ok, true, JSON.stringify(ok.detail));
    assert.deepEqual(Object.keys(ok.pack.server.modules[0].lane), ['path', 'summary']);
  });

  const cases = [
    ['声明了 lane 却没挂挂载点', { ...LANE_OK, uses: ['healthz'] }, 'MODULES_LANE_UNDECLARED'],
    ['挂了 lane 却没给路径', { id: 'm', entry: 'server/m.mjs', uses: ['lane'] }, 'MODULES_LANE_NEEDS_PATH'],
    ['路径不是字符串', { ...LANE_OK, lane: { path: 42 } }, 'MODULES_LANE_BAD_PATH'],
    ['lane 不是对象', { ...LANE_OK, lane: '/mod-ws/p/duel' }, 'MODULES_BAD_LANE'],
    ['lane 里有未知字段', { ...LANE_OK, lane: { path: '/mod-ws/p/duel', maxPeers: 4 } }, 'MODULES_BAD_LANE'],
    ['summary 是空白', { ...LANE_OK, lane: { path: '/mod-ws/p/duel', summary: '  ' } }, 'MODULES_LANE_BAD_SUMMARY'],
    ['路径在别人的命名空间里', { ...LANE_OK, lane: { path: '/duel' } }, 'MODULES_LANE_BAD_NAMESPACE'],
    ['路径抢引擎自己的端点', { ...LANE_OK, lane: { path: '/ws' } }, 'MODULES_LANE_BAD_NAMESPACE'],
  ];
  for (const [what, mod, code] of cases) {
    test(`${what} ⇒ ${code}`, () => {
      const bad = mk([mod]);
      assert.equal(bad.ok, false, `${what} must be refused`);
      assert.equal(bad.error, code);
    });
  }
});

describe('纯的那半：认领、撞车、限额、处理器还没就位', () => {
  test('认领成功 ⇒ 活表里多一行，且那份表就是交给宿主的同一引用', () => {
    const got = claimPackLane({ packId: 'p', moduleId: 'm', path: '/mod-ws/p/duel' });
    assert.equal(got.ok, true, got.reason);
    assert.equal(packLaneTable().length, 1);
    assert.equal(packLaneTable(), packLaneTable(), '同一引用：复制就丢掉「活」的语义');
    assert.deepEqual(packLaneRows(), [packLaneRows()[0]]);
    assert.equal(packLaneRows()[0].ready, false);
  });

  test('路径语法只有一份判据：非 root / 尾斜杠 / 带 query 都被同一条拒', () => {
    for (const path of ['duel', '/duel/', '/duel?room=1', '/du//el']) {
      assert.equal(isLanePath(path), false, `${path} must not be a lane path`);
      const got = claimPackLane({ packId: 'p', moduleId: 'm', path });
      assert.equal(got.ok, false);
      assert.equal(got.code, 'LANE_BAD_PATH');
    }
  });

  test('两条模块抢同一路径 ⇒ 后来者被点名，且说出是谁先认领的', () => {
    assert.equal(claimPackLane({ packId: 'a', moduleId: 'm', path: '/mod-ws/a/x' }).ok, true);
    const second = claimPackLane({ packId: 'b', moduleId: 'm', path: '/mod-ws/a/x' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'LANE_TAKEN');
    assert.match(second.reason, /already claimed by "a\/m"/);
  });

  test('一个模块不能认领两条 lane', () => {
    assert.equal(claimPackLane({ packId: 'p', moduleId: 'm', path: '/mod-ws/p/a' }).ok, true);
    const again = claimPackLane({ packId: 'p', moduleId: 'm', path: '/mod-ws/p/b' });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'LANE_DUPLICATE_MODULE');
  });

  test('表满 ⇒ 点名是每进程预算，不是每包预算', () => {
    for (let i = 0; i < MAX_WS_LANES; i++) {
      assert.equal(claimPackLane({ packId: `p${i}`, moduleId: 'm', path: `/mod-ws/p${i}/x` }).ok, true);
    }
    const over = claimPackLane({ packId: 'z', moduleId: 'm', path: '/mod-ws/z/x' });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'LANE_LIMIT');
  });

  test('没认领就挂处理器 ⇒ 点名，不静默收下', () => {
    const r = attachPackLaneHandler('p', 'm', () => {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LANE_NOT_CLAIMED');
    assert.equal(attachPackLaneHandler('p', 'm', 'not-a-function').code, 'LANE_NO_HANDLER');
  });

  test('处理器还没就位时升级 ⇒ 明确 503 并点名，绝不回落到 /ws', () => {
    const row = claimPackLane({ packId: 'p', moduleId: 'm', path: '/mod-ws/p/duel' }).row;
    let rejected = null;
    let destroyed = 0;
    row.onUpgrade({}, { destroy() { destroyed++; } }, Buffer.alloc(0), {
      reject: (code) => { rejected = code; }, log: { warn() {}, error() {} },
    });
    assert.equal(rejected, 503);
    assert.equal(destroyed, 0, '有 reject 就不该直接掐连接：客户端要能看清是 503');
  });

  test('处理器就位后转发，并多带一个 lane 身份；抛错就关连接（§28.44 的口径）', () => {
    const row = claimPackLane({ packId: 'p', moduleId: 'm', path: '/mod-ws/p/duel' }).row;
    const seen = [];
    assert.equal(attachPackLaneHandler('p', 'm', (req, socket, head, ctx) => { seen.push(ctx.lane.path); }).ok, true);
    row.onUpgrade({}, { destroy() { seen.push('destroyed'); } }, Buffer.alloc(0), { log: { warn() {}, error() {} } });
    assert.deepEqual(seen, ['/mod-ws/p/duel']);
    assert.equal(packLaneRows()[0].ready, true);

    attachPackLaneHandler('p', 'm', () => { throw new Error('boom'); });
    row.onUpgrade({}, { destroy() { seen.push('boom-destroyed'); } }, Buffer.alloc(0), { log: { warn() {}, error() {} } });
    assert.equal(seen[seen.length - 1], 'boom-destroyed');
  });
});
