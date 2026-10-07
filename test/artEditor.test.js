// test/artEditor.test.js — 工坊编辑器的外观素材（`pack.json.art`）图形入口，服务端那一半：状态、单个文件体检与保存。
//
// 这一页真正值得钉住的不是「字段写进去了」，而是**保存前把客户端那些静默失败挡在门外**：`.atlas` 与 `.skel` 必须
// 同目录同名（加载器从 skel 推 atlas，清单里那个字段只做内存回收，写错不报错、模型就是不出现）、`.atlas` 里每一页
// png 必须同目录存在、`.skel` 只认 3.8.x、`anims` 里的动画名必须在骨架里（名字错 → 模型能出来但不动，一条日志都没有）。
// 另外两条同样重要：写进去的东西必须能删掉（包括一条**会被加载器拒绝**的陈旧声明），以及删声明永远不被形状挡住 ——
// 否则作者会被自己写坏的一行锁在门外。
//
// 骨架二进制与图谱文本在测试里现造（布局与 test/workshopArt.test.js 的同一套：仓库不含任何游戏素材）。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createEditorServer } from '../editor/server.mjs';
import { loadData } from '../server/data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const PACK = 'art-pack';
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * POST helper（与 test/itemEditor.test.js 同一份）：一整套 `node --test` 并发跑起来时，回环连接可能还没写完请求
 * 就被重置（`ECONNRESET`，一个响应都没有）。那是传输层的事，编辑器本身 4xx/5xx 都是正常响应，所以只重发一次。
 */
async function post(url, body) {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    return await fetch(url, init);
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (code !== 'ECONNRESET') throw err;
    return fetch(url, init);
  }
}

/**
 * 一份**真的能被 @pixi-spine/runtime-3.8 解析**的 3.8 骨架二进制（布局见 test/workshopArt.test.js 的同一份注释：
 * hash + version、四个大端 float、nonessential，然后是一串空表与动画表；一条动画 = 名字 + 八段空 timeline 计数）。
 */
function skelBytes({ version = '3.8.99', anims = [] } = {}) {
  const varint = (n) => {
    const out = [];
    let v = n;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
  };
  const str = (s) => [...varint(s.length + 1), ...Buffer.from(s, 'utf8')];
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return [...b]; };
  return Buffer.from([
    ...str('stand-in'), ...str(version),
    ...f32(0), ...f32(0), ...f32(64), ...f32(64),
    0,              // nonessential
    ...varint(0),   // 字符串表
    ...varint(0),   // 骨骼
    ...varint(0),   // 槽位
    ...varint(0),   // IK 约束
    ...varint(0),   // 形变约束
    ...varint(0),   // 路径约束
    ...varint(0),   // 默认皮肤的槽位数
    ...varint(0),   // 皮肤表
    ...varint(0),   // 事件表
    ...varint(anims.length),
    ...anims.flatMap((n) => [...str(n), ...new Array(8).fill(0).flatMap(() => varint(0))]),
  ]);
}

/** 一段 atlas 文本：页名 + 页字段 + 一个区域（`size` / `pma` 可按需给或省）。 */
const atlasText = (page, { size = '64,64', pma = false } = {}) => [
  page,
  ...(size ? [`size: ${size}`] : []),
  'format: RGBA8888',
  'filter: Linear,Linear',
  'repeat: none',
  ...(pma ? ['pma: true'] : []),
  'Body',
  '  rotate: false',
  '  xy: 0, 0',
  '  size: 64, 64',
  '  orig: 64, 64',
  '  offset: 0, 0',
  '  index: -1',
  '',
].join('\n');

/** 一张 1×1 的真 PNG。 */
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f6e0000000049454e44ae426082', 'hex');

let tmp;
let wsRoot;
let editor;

const packDir = () => join(wsRoot, PACK);
const manifestPath = () => join(packDir(), 'pack.json');
const assetAbs = (rel) => join(packDir(), 'assets', ...rel.split('/'));
/** 放一个素材文件（自动建目录）—— 编辑器不上传素材，测试里就自己放。 */
function put(rel, data) {
  const abs = assetAbs(rel);
  fs.mkdirSync(dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}
/** 写 pack.json（2 空格缩进 + 结尾换行，与 writeJson 一致）。 */
const writeManifest = (obj) => fs.writeFileSync(manifestPath(), `${JSON.stringify(obj, null, 2)}\n`);
/** 读回 pack.json 的**原始文本**：键序、缩进与结尾换行都要能查。 */
const manifestText = () => fs.readFileSync(manifestPath(), 'utf8');
const manifest = () => JSON.parse(manifestText());
/** 写一条 art 声明，但**其余字段原样保留**（模拟「编辑器之外还有人写这个文件」）。 */
function patchArt(art, extra = {}) {
  const cur = manifest();
  writeManifest({ ...cur, ...extra, ...(art === undefined ? {} : { art }) });
  if (art === undefined) { const next = manifest(); delete next.art; writeManifest(next); }
}

/** 保存一条外观：POST /api/packs/<包>/art。 */
const save = (table, id, art) => post(`${editor.url}/api/packs/${PACK}/art`, { table, id, art });
/** 立刻读合并后的数据（与游戏同一套：data/*.json + 工坊叠加层）。 */
const merged = () => loadData(DATA_DIR, { log: quietLog, workshopDir: wsRoot });

before(async () => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-art-editor-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(join(wsRoot, PACK, 'assets', 'art'), { recursive: true });
  // 一个只有外观素材的包（`art` 是合法内容，可以不带任何 data 文件）；有 assets/ 就必须声明 license
  writeManifest({ id: PACK, name: '外观测试包', version: '1.0.0', license: 'CC0-1.0' });
  // 一份齐全的模型：3.8 骨架（Idle / Attack）、同名图谱、图谱那一页 png
  put('art/op.skel', skelBytes({ anims: ['Idle', 'Attack'] }));
  put('art/op.atlas', atlasText('op.png'));
  put('art/op.png', PNG_1PX);
  put('art/avatar.png', PNG_1PX);
  put('art/portrait.png', PNG_1PX);
  editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile: join(tmp, 'support.json') });
});
after(async () => {
  await editor?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('外观素材：状态接口（art + 真实文件 + 骨架/图谱解析）', () => {
  test('GET /api/state 带上本包的 art、assets/ 里真的有的文件，以及每条已声明 spine 的动画名与图谱页名', async () => {
    put('art/back.skel', skelBytes({ anims: ['Idle'] }));
    put('art/back.atlas', atlasText('back.png', { pma: true }));
    put('art/back.png', PNG_1PX);
    patchArt({
      chars: {
        char_ws_hero: {
          avatar: 'art/avatar.png',
          spine: { front: { skel: 'art/op.skel', atlas: 'art/op.atlas', textures: ['art/op.png'], anims: { idle: 'Idle' } } },
        },
      },
      enemies: { enemy_ws_thing: { icon: 'art/avatar.png', spine: { skel: 'art/back.skel', atlas: 'art/back.atlas' } } },
    });

    const state = await fetch(`${editor.url}/api/state`).then((r) => r.json());
    const art = state.packArt.find((p) => p.id === PACK);
    assert.ok(art, '/api/state 必须带上 packArt');
    // 原样读出来（页面要能显示并删掉校验器会拒绝的那条，所以这里不做任何过滤）
    assert.equal(art.art.chars.char_ws_hero.avatar, 'art/avatar.png');
    assert.equal(art.art.enemies.enemy_ws_thing.spine.skel, 'art/back.skel');
    // 只列真的能服务的文件（编辑器不上传素材，作者自己放进来）
    for (const rel of ['art/op.skel', 'art/op.atlas', 'art/op.png', 'art/avatar.png', 'art/back.skel']) {
      assert.ok(art.files.includes(rel), `${rel} 应该出现在 files 里`);
    }
    // 骨架：动画名与版本（客户端自己那个解析器读出来的，所以下拉里的候选就是真能播的）
    assert.deepEqual(art.skels['art/op.skel'].animations, ['Idle', 'Attack']);
    assert.equal(art.skels['art/op.skel'].version, '3.8.99');
    assert.equal(art.skels['art/op.skel'].note, null);
    assert.deepEqual(art.skels['art/back.skel'].animations, ['Idle']);
    // 图谱：页名（以 .atlas 文本为准，清单里的 textures 只做内存回收）
    assert.deepEqual(art.atlases['art/op.atlas'].pages, ['op.png']);
    assert.equal(art.atlases['art/op.atlas'].hasSize, true);
    assert.equal(art.atlases['art/back.atlas'].hasPma, true);
    // 只解析声明过的文件：一个没被任何 art 条目引用的 .skel 不进这张表（不扫全包）
    assert.equal(Object.hasOwn(art.skels, 'art/unused.skel'), false);
  });

  test('GET /api/enemies 也带同一份 packArt（怪物页那一段用它）', async () => {
    const data = await fetch(`${editor.url}/api/enemies`).then((r) => r.json());
    const art = data.packArt.find((p) => p.id === PACK);
    assert.ok(art);
    assert.deepEqual(art.skels['art/op.skel'].animations, ['Idle', 'Attack']);
    // 怪物页的外观面板里也有 token 那一段，所以这份候选跟着一起给（与干员页同一份）
    assert.ok(data.tokenChoices.some((t) => t.id === 'token_10000_silent_healrb'));
  });

  test('GET /api/packs/<包>/art/inspect：还没写进 pack.json 的文件也能问一次候选', async () => {
    const r = await fetch(`${editor.url}/api/packs/${PACK}/art/inspect?skel=${encodeURIComponent('art/op.skel')}&atlas=${encodeURIComponent('art/op.atlas')}`).then((x) => x.json());
    assert.deepEqual(r.skel.animations, ['Idle', 'Attack']);
    assert.deepEqual(r.atlas.pages, ['op.png']);
    const only = await fetch(`${editor.url}/api/packs/${PACK}/art/inspect?skel=${encodeURIComponent('art/op.skel')}`).then((x) => x.json());
    assert.equal(only.atlas, null);
    assert.equal((await fetch(`${editor.url}/api/packs/${PACK}/art/inspect`)).status, 400, '一个路径都不给就是坏请求');
    const missing = await fetch(`${editor.url}/api/packs/${PACK}/art/inspect?skel=${encodeURIComponent('art/nope.skel')}`).then((x) => x.json());
    assert.deepEqual(missing.skel.animations, []);
    assert.match(missing.skel.note, /不在包的 assets\//);
  });

  // `art.tokens` 的键（tokenId）不像干员/怪物那样能靠「本包已有记录」列出来：新包这里恒为空，而 token 基本是给
  // 一个已有的召唤物换模型。候选表因此是跨来源的 —— 官方 tokens.json ∪ 官方与各包 chess.json 的 tokens 数组 ∪
  // 各包 tokens.json。这条测试把四个来源各钉一个，并确认排序与去重（下拉的读法）。
  test('GET /api/state 带上 tokenChoices：官方 tokens.json ∪ chess 的 tokens ∪ 各包的 tokens.json', async () => {
    // 一个只作候选来源的包：tokens.json 声明一个、chess.json 只「引用」一个（后者证明 chess 那条路也真的收了）
    const srcPack = join(wsRoot, 'token-src-pack');
    fs.mkdirSync(srcPack, { recursive: true });
    fs.writeFileSync(join(srcPack, 'pack.json'), `${JSON.stringify({ id: 'token-src-pack', name: '候选来源', version: '1.0.0' }, null, 2)}\n`);
    fs.writeFileSync(join(srcPack, 'tokens.json'), `${JSON.stringify({ token_ws_pack: { tokenId: 'token_ws_pack', name: '包里的召唤物' } }, null, 2)}\n`);
    fs.writeFileSync(join(srcPack, 'chess.json'), `${JSON.stringify({ char_ws_caller: { chessId: 'char_ws_caller', tokens: ['token_ws_chess'] } }, null, 2)}\n`);
    try {
      const state = await fetch(`${editor.url}/api/state`).then((r) => r.json());
      assert.ok(Array.isArray(state.tokenChoices) && state.tokenChoices.length, '/api/state 必须带上 tokenChoices');
      // 官方 tokens.json 的键：带名字、from 为空（不是任何包声明的）
      assert.deepEqual(state.tokenChoices.find((t) => t.id === 'token_10000_silent_healrb'), { id: 'token_10000_silent_healrb', name: '医疗探机', from: '' });
      // 包自己的 tokens.json：名字与 from 都跟着来
      assert.deepEqual(state.tokenChoices.find((t) => t.id === 'token_ws_pack'), { id: 'token_ws_pack', name: '包里的召唤物', from: 'token-src-pack' });
      // 只在 chess 记录的 tokens 数组里出现过的 id：也必须收（name 为空，因为没有任何表给它名字）
      assert.deepEqual(state.tokenChoices.find((t) => t.id === 'token_ws_chess'), { id: 'token_ws_chess', name: '', from: 'token-src-pack' });
      const ids = state.tokenChoices.map((t) => t.id);
      assert.deepEqual(ids, [...ids].sort(), '按 id 排序（下拉读起来才稳定）');
      assert.equal(new Set(ids).size, ids.length, '同一个 id 不能被收两次');
    } finally {
      fs.rmSync(srcPack, { recursive: true, force: true });
    }
  });

  test('解析按 mtime 缓存：文件没改不重读，改了立刻重解析', async () => {
    put('art/cached.skel', skelBytes({ anims: ['Idle'] }));
    const ask = async () => (await fetch(`${editor.url}/api/packs/${PACK}/art/inspect?skel=${encodeURIComponent('art/cached.skel')}`).then((x) => x.json())).skel.animations;
    assert.deepEqual(await ask(), ['Idle']);
    assert.deepEqual(await ask(), ['Idle'], '第二次走缓存，结论一样');
    fs.writeFileSync(assetAbs('art/cached.skel'), skelBytes({ anims: ['Idle', 'Attack'] }));
    // mtime 显式往后挪：同一毫秒内的两次写入不该被当成「文件没变」（否则这条测试会随机假通过）
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(assetAbs('art/cached.skel'), later, later);
    assert.deepEqual(await ask(), ['Idle', 'Attack'], '文件一改就必须重解析');
  });

  test('文件太大就不解析：空候选 + 一条 note，绝不抛错拖慢整页', async () => {
    put('art/big.skel', Buffer.alloc((9 << 20), 0));
    const r = await fetch(`${editor.url}/api/packs/${PACK}/art/inspect?skel=${encodeURIComponent('art/big.skel')}`).then((x) => x.json());
    assert.deepEqual(r.skel.animations, []);
    assert.match(r.skel.note, /解析上限/);
    assert.ok(r.skel.bytes > (8 << 20));
    assert.equal(r.skel.kind, 'toolarge', '调用方要能区分「我们没解析」与「解析了但坏了」（见保存那一组）');
  });
});

describe('外观素材：写进 pack.json（覆盖式 + 逐级清理 + 其余字段一字不动）', () => {
  test('保存一条 chars 条目，游戏加载器真的把它并进 assets.chars', async () => {
    patchArt(undefined, { author: '测试作者', overrides: ['items:foo'] });
    const entry = {
      avatar: 'art/avatar.png',
      portrait: 'art/portrait.png',
      spine: {
        front: {
          skel: 'art/op.skel', atlas: 'art/op.atlas', textures: ['art/op.png'], pma: false,
          anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null } },
        },
      },
    };
    const r = await save('chars', 'char_ws_hero', entry).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.warnings, [], '这一条干干净净，不该有警告');
    assert.deepEqual(r.art.chars.char_ws_hero, entry, '回话要带上写入后的 art（照 item-icons 的做法）');
    assert.deepEqual(manifest().art.chars.char_ws_hero, entry);
    // 其余字段、键序、缩进与结尾换行原样保留（writeJson 只动了 art 这一处）
    assert.equal(manifest().author, '测试作者');
    assert.deepEqual(manifest().overrides, ['items:foo']);
    assert.equal(manifestText().endsWith('}\n'), true);
    assert.deepEqual(Object.keys(manifest()), ['id', 'name', 'version', 'license', 'author', 'overrides', 'art']);

    // 端到端：客户端读的就是合并后的 assets.chars，路径走 /workshop-assets 那条唯一路由
    const chars = merged().assets.chars.char_ws_hero;
    assert.equal(chars.avatar, `/workshop-assets/${PACK}/art/avatar.png`);
    assert.equal(chars.portrait, `/workshop-assets/${PACK}/art/portrait.png`);
    assert.equal(chars.spine.front.skel, `/workshop-assets/${PACK}/art/op.skel`);
    // 硬约束 1：加载器从 skel 推出 atlas —— 合并后这两条必须同目录同名
    assert.equal(chars.spine.front.atlas, chars.spine.front.skel.replace(/\.skel$/, '.atlas'));
    assert.deepEqual(chars.spine.front.anims, entry.spine.front.anims, 'anims 原样并进去（客户端按角色名播动画）');
  });

  test('怪物与召唤物用的是扁平 spine，各自并进 assets.enemies / assets.tokens', async () => {
    put('art/thing.skel', skelBytes({ anims: ['Idle', 'Die'] }));
    put('art/thing.atlas', atlasText('thing.png'));
    put('art/thing.png', PNG_1PX);
    put('art/token.png', PNG_1PX);
    const enemy = { icon: 'art/avatar.png', spineAliasOf: 'enemy_1007_slime', spine: { skel: 'art/thing.skel', atlas: 'art/thing.atlas', anims: { idle: 'Idle', die: 'Die' } } };
    const token = { avatar: 'art/token.png', owner: 'chess_ws_hero', spine: { skel: 'art/op.skel', atlas: 'art/op.atlas' } };
    assert.equal((await save('enemies', 'enemy_ws_thing', enemy)).status, 200);
    assert.equal((await save('tokens', 'token_ws_hero', token)).status, 200);
    const assets = merged().assets;
    assert.equal(assets.enemies.enemy_ws_thing.icon, `/workshop-assets/${PACK}/art/avatar.png`);
    assert.equal(assets.enemies.enemy_ws_thing.spineAliasOf, 'enemy_1007_slime', '原样抄的字符串不做 URL 化');
    assert.equal(assets.enemies.enemy_ws_thing.spine.skel, `/workshop-assets/${PACK}/art/thing.skel`);
    assert.equal(assets.tokens.token_ws_hero.owner, 'chess_ws_hero');
    assert.equal(assets.tokens.token_ws_hero.spine.atlas, `/workshop-assets/${PACK}/art/op.atlas`);
    // 写一张表不动另一张
    assert.deepEqual(manifest().art.chars.char_ws_hero.avatar, 'art/avatar.png');
  });

  test('一条 id 覆盖式重写：只动这一处，也不碰别的表', async () => {
    const before = manifest();
    const first = await save('chars', 'char_ws_hero', { avatar: 'art/portrait.png' }).then((x) => x.json());
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(manifest().art.chars.char_ws_hero, { avatar: 'art/portrait.png' });
    assert.deepEqual(manifest().art.tokens, before.art.tokens, '别的表一个字都不动');
    assert.deepEqual(manifest().art.enemies, before.art.enemies);
  });

  test('空对象逐级清理：条目空了删 id、表空了删表、art 空了删 art', async () => {
    assert.equal((await save('chars', 'char_ws_hero', {})).status, 200, '空对象 = 删掉这条声明');
    assert.equal('char_ws_hero' in (manifest().art.chars ?? {}), false);
    assert.ok(manifest().art.tokens.token_ws_hero, '同一次删除不该波及别的表');
    // 删掉最后一条：art 这个键本身也要消失（留一个空表会被加载器拒绝）
    assert.equal((await save('tokens', 'token_ws_hero', null)).status, 200, 'null 也等于删');
    assert.equal((await save('enemies', 'enemy_ws_thing', {})).status, 200);
    assert.equal('art' in manifest(), false, 'art 空了就把 art 键删掉');
  });

  test('能删掉一条**会被加载器拒绝**的陈旧声明（作者不该被自己写坏的那一行锁住）', async () => {
    patchArt({ chars: { char_ws_ghost: { nope: 1 } }, tokens: { token_ws_ok: { avatar: 'art/avatar.png' } } });
    // 状态接口照旧原样读出它，页面才能显示并给一个删除按钮
    const state = await fetch(`${editor.url}/api/state`).then((r) => r.json());
    assert.deepEqual(state.packArt.find((p) => p.id === PACK).art.chars.char_ws_ghost, { nope: 1 });
    // 删它：不被形状挡住，其余声明原样留在原地
    const r = await save('chars', 'char_ws_ghost', null).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(manifest().art.tokens.token_ws_ok, { avatar: 'art/avatar.png' });
    assert.equal('chars' in manifest().art, false);
    // 而且现在这份 pack.json 加载器接受了
    const ok = await fetch(`${editor.url}/api/state`).then((x) => x.json());
    assert.deepEqual(ok.loadErrors.filter((e) => e.pack === PACK), [], '删掉之后不该再有加载错误');
    patchArt(undefined);
  });

  test('另一条声明坏了也不妨碍删这一条：回话里给出 warnings', async () => {
    patchArt({ chars: { char_ws_bad: { nope: 1 } }, tokens: { token_ws_ok: { avatar: 'art/avatar.png' } } });
    const r = await save('tokens', 'token_ws_ok', null).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /ART_UNKNOWN_FIELD|会被加载器拒绝/);
    patchArt(undefined);
  });

  test('art 整个不是一个对象时：状态照旧原样读出，删一次就把它去掉（并给一条 warning）', async () => {
    const cur = manifest();
    writeManifest({ ...cur, art: { chars: { char_ws_ok: { avatar: 'art/avatar.png' } } } });
    // 先手改坏：art 变成一个字符串（加载器 ART_BAD_SHAPE）
    writeManifest({ ...manifest(), art: 'oops' });
    const state = await fetch(`${editor.url}/api/state`).then((r) => r.json());
    assert.equal(state.packArt.find((p) => p.id === PACK).art, 'oops', '状态要原样读出坏值，页面才看得见它');
    assert.ok(state.loadErrors.some((e) => e.pack === PACK && /ART_BAD_SHAPE/.test(String(e.reason))), '加载器确实会拒绝它');
    const r = await save('chars', 'x', null).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.warnings.join(' '), /不是一个对象/);
    assert.equal('art' in manifest(), false, '这份坏值被整个丢掉了');
    patchArt(undefined);
  });
});

describe('外观素材：保存前必须挡住的东西', () => {
  test('形状非法：直接把加载器的错误码与 detail 回给作者', async () => {
    const before = manifestText();
    const bad = await save('chars', 'char_ws_x', { nope: 'art/avatar.png' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /ART_UNKNOWN_FIELD/);
    const incomplete = await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/op.skel' } } });
    assert.equal(incomplete.status, 400);
    assert.match((await incomplete.json()).error, /ART_SPINE_INCOMPLETE/);
    const notObject = await save('chars', 'char_ws_x', 'art/avatar.png');
    assert.equal(notObject.status, 400);
    assert.match((await notObject.json()).error, /必须是这一条外观的完整内容/);
    assert.equal(manifestText(), before, '被拒之后 pack.json 一个字节都不该变');
  });

  test('表名与 id 不合法', async () => {
    const before = manifestText();
    assert.equal((await save('weapons', 'char_ws_x', { avatar: 'art/avatar.png' })).status, 400);
    assert.equal((await save('chars', 'bad id!', { avatar: 'art/avatar.png' })).status, 400);
    assert.equal((await save('chars', '', { avatar: 'art/avatar.png' })).status, 400);
    assert.equal(manifestText(), before);
  });

  test('路径穿越与绝对路径', async () => {
    for (const p of ['../secret.png', '/abs.png', 'art/../../secret.png', 'C:/x.png', 'art\\avatar.png']) {
      const res = await save('chars', 'char_ws_x', { avatar: p });
      assert.equal(res.status, 400, `${p} 应该被拒`);
    }
  });

  test('文件不存在 / 扩展名不能服务 / 不是图片', async () => {
    put('art/notes.txt', 'x');
    const missing = await save('chars', 'char_ws_x', { avatar: 'art/nope.png' });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /不存在/);
    const notServed = await save('chars', 'char_ws_x', { avatar: 'art/notes.txt' });
    assert.equal(notServed.status, 400);
    assert.match((await notServed.json()).error, /白名单/);
    const notImage = await save('chars', 'char_ws_x', { avatar: 'art/op.skel' });
    assert.equal(notImage.status, 400);
    assert.match((await notImage.json()).error, /不是图片/);
    const notSkel = await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/op.png', atlas: 'art/op.png' } } });
    assert.equal(notSkel.status, 400);
    assert.match((await notSkel.json()).error, /不是 \.skel/);
  });

  test('硬约束 1：atlas 必须与 skel 同目录同名', async () => {
    put('art/other.atlas', atlasText('other.png'));
    put('art/other.png', PNG_1PX);
    const res = await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/op.skel', atlas: 'art/other.atlas' } } });
    assert.equal(res.status, 400);
    const msg = (await res.json()).error;
    assert.match(msg, /不一致/);
    assert.match(msg, /art\/op\.atlas/, '要说清加载器推出来的是哪一个');
  });

  test('硬约束 2：图谱里写的每一页 png 必须与它同目录且真的存在（一图多页也要查）', async () => {
    put('art/pages.skel', skelBytes({ anims: ['Idle'] }));
    put('art/pages.atlas', `${atlasText('pages_a.png')}\n${atlasText('pages_b.png')}`);
    put('art/pages_a.png', PNG_1PX);
    const missingPage = await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/pages.skel', atlas: 'art/pages.atlas' } } });
    assert.equal(missingPage.status, 400);
    assert.match((await missingPage.json()).error, /pages_b\.png/);
    // 补上第二页之后就能存了 —— 也证明「不能假设一图一模型」这条不是空话
    put('art/pages_b.png', PNG_1PX);
    assert.equal((await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/pages.skel', atlas: 'art/pages.atlas' } } })).status, 200);
  });

  test('硬约束 3：.skel 只收 3.8.x', async () => {
    put('art/old.skel', skelBytes({ version: '4.1.0', anims: ['Idle'] }));
    put('art/old.atlas', atlasText('old.png'));
    put('art/old.png', PNG_1PX);
    const res = await save('chars', 'char_ws_x', { spine: { front: { skel: 'art/old.skel', atlas: 'art/old.atlas' } } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /3\.8\.x/);
  });

  test('anims 里的动画名必须在骨架里（名字错 → 模型能出来但不动，而且没有日志）', async () => {
    const res = await save('chars', 'char_ws_x', {
      spine: { front: { skel: 'art/op.skel', atlas: 'art/op.atlas', anims: { idle: 'Idle', attack: { loop: 'Attackk' } } } },
    });
    assert.equal(res.status, 400);
    const msg = (await res.json()).error;
    assert.match(msg, /Attackk/);
    assert.match(msg, /Idle、Attack/, '要把骨架里真的有的名字列出来，作者才好改');
    // 修好就能存
    assert.equal((await save('chars', 'char_ws_x', {
      spine: { front: { skel: 'art/op.skel', atlas: 'art/op.atlas', anims: { idle: 'Idle', attack: { loop: 'Attack' } } } },
    })).status, 200);
  });

  test('有 assets/ 就必须声明 license：写外观也会被挡（与语音、图标同一条规则）', async () => {
    const other = join(wsRoot, 'no-license-pack');
    fs.mkdirSync(join(other, 'assets', 'art'), { recursive: true });
    fs.writeFileSync(join(other, 'pack.json'), `${JSON.stringify({ id: 'no-license-pack', name: 'x', version: '1.0.0' }, null, 2)}\n`);
    const res = await post(`${editor.url}/api/packs/no-license-pack/art`, { table: 'chars', id: 'char_ws_x', art: { avatar: 'art/avatar.png' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ASSETS_NEED_LICENSE/);
  });

  test('上一组用例写进去的那条声明还在（拒绝不留半成品，成功不留垃圾）', async () => {
    assert.deepEqual(Object.keys(manifest().art).sort(), ['chars']);
    assert.ok(manifest().art.chars.char_ws_x);
  });

  // 「解析不出来」此前只给一条警告就放行，而命令行校验器对同一件事报 ART_SPINE_VERSION / error ——
  // 编辑器比它松的话，作者会得到一个「编辑器让你存了、命令行说你错了」的包，而客户端两边都只是**静默**不画。
  test('骨架字节不是 3.8 骨架时是硬错误；只有「超过我们自己的解析上限」才留警告', async () => {
    put('art/broken.skel', Buffer.from('this is not a skeleton, not even close'));
    put('art/broken.atlas', atlasText('broken.png'));
    put('art/broken.png', PNG_1PX);
    const bad = await save('chars', 'char_ws_broken', {
      spine: { front: { skel: 'art/broken.skel', atlas: 'art/broken.atlas', textures: ['art/broken.png'] } },
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /骨架解析失败/);
    assert.ok(!manifest().art.chars.char_ws_broken, '拒绝不留半成品');

    // 对照：同一个形状，只是文件大过解析上限 —— 骨架可能是好的（我们只是没读），所以照旧能存
    put('art/huge.skel', Buffer.alloc((9 << 20), 0));
    put('art/huge.atlas', atlasText('huge.png'));
    put('art/huge.png', PNG_1PX);
    const ok = await save('chars', 'char_ws_huge', {
      spine: { front: { skel: 'art/huge.skel', atlas: 'art/huge.atlas', textures: ['art/huge.png'] } },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.match(body.warnings.join('\n'), /解析上限/);
    assert.equal(manifest().art.chars.char_ws_huge.spine.front.skel, 'art/huge.skel');
  });
});

describe('外观素材：每张表的路径字段都被当成文件查（把这张表和加载器钉在一起）', () => {
  test('chars 的四个图片字段：少了文件就是「不存在」，不是「形状不对」', async () => {
    for (const field of ['avatar', 'avatarE2', 'portrait', 'portraitE2']) {
      const res = await save('chars', 'char_ws_x', { [field]: `art/missing_${field}.png` });
      assert.equal(res.status, 400, `${field} 应该被当成路径查`);
      assert.match((await res.json()).error, /不存在/, `${field} 走的是存在性检查`);
    }
  });

  test('enemies 的 icon 与 tokens 的 avatar 同理', async () => {
    for (const [table, field] of [['enemies', 'icon'], ['tokens', 'avatar']]) {
      const res = await save(table, 'x_ws_x', { [field]: 'art/missing.png' });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /不存在/);
    }
  });

  test('不认识的原样字符串字段仍由加载器否掉（形状表没漂移）', async () => {
    const res = await save('enemies', 'enemy_ws_x', { spineAliasOf: 'enemy_1007_slime', owner: 'chess_x' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /ART_UNKNOWN_FIELD/);
    // 而 strips 表里真的有的那一个原样通过
    assert.equal((await save('enemies', 'enemy_ws_x', { spineAliasOf: 'enemy_1007_slime' })).status, 200);
  });
});
