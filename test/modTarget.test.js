// test/modTarget.test.mjs — `pack.json.target`（跨宿主清单）的**契约测试**。
//
// 这一份回答的不是「功能对不对」，而是「契约语义有没有变」。四问，每问都有实测的钉子：
//   ① 缺省逐字节不变：不写 `target` 时，归一化清单与包身份摘要**逐字节**等于移植前实测的那一袋（FROZEN）。
//      钉子能变红：把 `target: 'forge'` 无条件写进归一化结果（或把闭集放松）⇒ 这一袋全部对不上。
//   ② 抬不抬版本：`MOD_API_VERSION` / `PROTOCOL_VERSION` 一字不动 —— 加一格能力不抬世代（docs/UPSTREAM-UPGRADE.md）。
//   ③ 闭集 / 线格式：顶层键 34 → 35，多出来的那一格是 `target`；不写就不进清单，于是 `packHash` / `assetsDigest`
//      与 `/mods/catalog.json` 对老包逐字节不变。
//   ④ 跨宿主误用：给 Stardust 宿主的包落在 Forge 上时是**具名**的（`foreign` 一行 + 一行启动日志），
//      不是「静默半可用」—— 同时它确实**不会**进 `/mods/catalog.json`，这一条在报告里如实写出，不藏。
//   ⑤ 三面接线（业主裁定 2026-10-12）：`foreign` 必须**响亮** —— 校验器 / 管理器 CLI / 编辑器三个作者可见面
//      都要**点名**它、且说得出**为什么**。这一条也有牙：把任一面接回「不读 foreign」⇒ 当场红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  normalizePackManifest, PACK_FIELDS, PACK_TARGETS, STARDUST_TARGET_FIELDS, STARDUST_CAPABILITY_FIELDS,
} from '../shared/workshop.js';
import { canonicalJson, sha256Hex } from '../shared/modIdentity.js';
import { MOD_API_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { loadWorkshop } from '../server/workshop.js';
import { buildModCatalog } from '../server/modCatalog.js';
import { createEditorServer } from '../editor/server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

/** 语料包的公共元信息（与实测脚本 `_up/k10/target-probe.mjs` 的语料逐字相同）。 */
const M = (over) => ({ id: 'corpus-pack', name: '语料包', version: '1.0.0', license: 'CC0-1.0', ...over });

/**
 * 移植前（`de6d822a`，`target` 还不存在）在**同一个函数**上实测出来的 `sha256(canonicalJson(normalizePackManifest(...).pack))`。
 * 这一袋字面量就是「缺省逐字节不变」这条断言的钉子：任何一个字节能被 `target` 这一刀碰到，它就当场红。
 */
const FROZEN = new Map([
  ['min-content', 'a43da14e14f0b67d96965c3897074abfa4aaf82a7a091bdebed8b7f27c5916c4'],
  ['voices', 'db1845aae718df69b4fba4f16da4c18b92c91c82004f05e37156c894035bba13'],
  ['voiceLangs', '73c3bd0740fd94f05988186ad1eb0734d53478c5dee5297d7704b94f3028f60b'],
  ['icons', 'b110ef69468aeafed967b34844e67308090988e9278804b47e6bf39656be5366'],
  ['art', '9ed968df9d0163881c3df370fcf38050a6f29fef62a0bd621a427a6a8abf4997'],
  ['skins', 'bef9ba8b52e1ddf07f042273c410d99c6190bba773783c32b611bc129cad1445'],
  ['variants', 'bdde916b84444401335c6aa601f359af27591b2303e3e1673ebe9c6c9e0c6b29'],
  ['forms', 'c4f4cb36e16d25ad07d360845e2a169f924073babc551824579c3fb91b88e7e0'],
  ['fx', '61332132fdcd85c2cffc0fc1792c72ce01e8edeb664642bf5a6ca7a8aedbc20a'],
  ['operators', '37e2525257f07fd125596e297a71b1d9e68b829f885d36408535ae6ad1e9c36d'],
  ['playtest', 'a43da14e14f0b67d96965c3897074abfa4aaf82a7a091bdebed8b7f27c5916c4'],
  ['overrides', '7f0d107b91a69475750e7a35488e39befbbf4c932fb5e725ae1d6e211f6dea51'],
  ['meta-fields', '14a30d75c818a5cf81caeca2f5e80069db076985b668ff96071a11ab5ae8f22f'],
  ['client', '0183604fff14d2494b5004dc6628843e45155ed4f55d4f6d1871e274505fab6b'],
  ['client-theme', '60824b61ffcb193bbf05b5437370e22697588e216003aeb70e64df989de04c93'],
  ['routes', 'ba00e717bed0986bee0298205a77de295199cfe6a1db69b575cef82063660ded'],
  ['server', '8dd246a562130bdec2125c89be079a6b8023980be929f12e0fd1b5204e6fe44a'],
]);

/** 同一袋语料（覆盖每一个顶层键，**一个都不写 `target`**）。 */
const CORPUS = {
  'min-content': M({ content: ['items'] }),
  voices: M({ content: [], voices: { char_1: { start: ['a.ogg'] } } }),
  voiceLangs: M({ content: [], voiceLangs: { en: { char_1: { start: ['a.ogg'] } } } }),
  icons: M({ content: [], bondIcons: { bond_a: 'b.png' }, itemIcons: { item_a: 'i.png' } }),
  art: M({ content: [], art: { chars: { char_1: { avatar: 'a.png' } } } }),
  skins: M({ content: [], skins: [{ id: 's1', charId: 'char_1', name: '时装', art: { avatar: 'a.png' } }] }),
  variants: M({ content: ['items'], variants: [{ axis: 'training', default: 'official' }], combat: true }),
  forms: M({ content: [], forms: { chars: { sp_test_1: { elite: { roles: { idle: 'a' } } } } } }),
  fx: M({ content: [], fx: { silentPhases: ['death'] } }),
  operators: M({ content: [], operators: { char_1: { powers: ['p'], bonds: ['b'] } } }),
  playtest: M({ content: ['items'], playtest: { directToHand: [] } }),
  overrides: M({ content: ['items'], overrides: ['items:item_a'] }),
  'meta-fields': M({ content: ['items'], author: 'a', description: 'd', gameVersion: '0.2.4', game: '>=0.2.0', api: '>=1 <2', layer: 'A', combat: false }),
  client: M({ content: ['items'], client: { panels: [{ id: 'p', slot: 'screen.game.hud', module: 'client/p.js' }] } }),
  'client-theme': M({ content: ['items'], client: { theme: { vars: { '--t-fast': '0s' } } } }),
  routes: M({ content: ['items'], routes: [{ path: '/x', file: 'x.json', cache: 'no-store' }] }),
  server: M({ content: ['items'], server: { preDispatch: { module: 'srv/p.mjs', policy: 'srv/policy.json', intercepts: ['ping'] } } }),
};
/** 需要 `assets/` 文件夹的贡献项：装载器就是这么传 `hasAssets` 的。 */
const NEEDS_ASSETS = new Set(['voices', 'voiceLangs', 'icons', 'art', 'skins']);

const norm = (raw, name = raw.id) => normalizePackManifest(raw, raw.id, { hasAssets: NEEDS_ASSETS.has(name) });

const star = (over = {}) => ({ id: 'sd-pack', name: 'sd', version: '1.0.0', license: 'CC0-1.0', target: 'stardust', type: 'mod', capabilities: [], ...over });

test('① 缺省逐字节不变：不写 `target` 时归一化清单与移植前实测的摘要逐字节相同', () => {
  for (const [name, raw] of Object.entries(CORPUS)) {
    const r = norm(raw, name);
    assert.equal(r.ok, true, `${name}: ${r.ok ? '' : `${r.error}: ${r.detail}`}`);
    assert.equal(sha256Hex(canonicalJson(r.pack)), FROZEN.get(name), `${name}: 归一化清单被 target 这一刀碰到了`);
    assert.equal(Object.hasOwn(r.pack, 'target'), false, `${name}: 没写 target 就不该长出这个键`);
  }
});

test('① 钉子有牙：无条件把 target 写进归一化结果 ⇒ 上面那一袋摘要当场对不上（合成输入验失败分支）', () => {
  // 这一条不依赖「把源码改坏」，它直接构造「无条件写入」的产物，证明 FROZEN 那一袋确实会因为多一个键而变红。
  const r = norm(CORPUS['min-content'], 'min-content');
  const polluted = { ...r.pack, target: 'forge' };
  assert.notEqual(sha256Hex(canonicalJson(polluted)), FROZEN.get('min-content'),
    '多一个 target 键而摘要不变 ⇒ 这一袋字面量不是钉子（哈希没覆盖到归一化清单）');
});

test('② 不抬版本：MOD_API_VERSION / PROTOCOL_VERSION 一字不动（加一格能力不抬世代）', () => {
  assert.equal(MOD_API_VERSION, 1, '加一格包声明不抬模组 API 世代（docs/UPSTREAM-UPGRADE.md）');
  assert.equal(PROTOCOL_VERSION, 2, 'target 不进线格式：它是清单字段，不是一条消息');
  // 已发布的包照旧通过：`api` 区间仍按今天的世代比对
  const r = norm(M({ content: ['items'], api: '>=1 <2' }), 'x');
  assert.equal(r.ok, true, r.ok ? '' : `${r.error}: ${r.detail}`);
});

test('③ 闭集：`target` 是顶层键的一员；闭枚举与 Stardust profile 字段都在', () => {
  assert.ok(PACK_FIELDS.includes('target'), '`target` 必须在 PACK_FIELDS 里，否则整个包被 PACK_UNKNOWN_FIELD 拒掉');
  assert.deepEqual([...PACK_TARGETS], ['forge', 'stardust']);
  assert.deepEqual([...STARDUST_TARGET_FIELDS], ['type', 'capabilities', 'englishName', 'authors', 'app']);
  assert.deepEqual(Object.keys(STARDUST_CAPABILITY_FIELDS), ['announcements']);
  assert.deepEqual([...STARDUST_CAPABILITY_FIELDS.announcements], ['announcements']);
});

test('③ `target: "forge"`（缺省）下 `type` / `capabilities` 仍是未知键（闭集一字未松）', () => {
  for (const key of ['type', 'capabilities']) {
    const r = norm(M({ content: ['items'], [key]: key === 'capabilities' ? [] : 'mod' }), 'x');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PACK_UNKNOWN_FIELD');
    assert.match(r.detail, /is not a field of this pack format/);
  }
});

test('③ 显式写 `target: "forge"` 是一条声明 ⇒ 进归一化结果（与 skins / variants 同一条纪律）', () => {
  const absent = norm(M({ content: ['items'] }), 'x');
  const explicit = norm(M({ content: ['items'], target: 'forge' }), 'x');
  assert.equal(explicit.ok, true, explicit.ok ? '' : `${explicit.error}: ${explicit.detail}`);
  assert.equal(explicit.pack.target, 'forge');
  assert.notEqual(explicit.hash ?? sha256Hex(canonicalJson(explicit.pack)), sha256Hex(canonicalJson(absent.pack)),
    '显式声明了目标引擎就是一个声明：它必须进身份哈希，否则两份行为不同的包会共用一个摘要（§28.2）');
});

test('③ 未知 target 具名拒绝，不猜', () => {
  const r = norm(M({ content: ['items'], target: 'skyrim' }), 'x');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'PACK_TARGET_UNKNOWN');
  assert.match(r.detail, /is not one of forge \/ stardust/);
});

test('④ Stardust 目标：声明型包不受 EMPTY_PACK 约束，profile 两格按 Stardust 规则校验', () => {
  const ok = norm(star({ capabilities: ['skins', 'skins'] }), 'sd-pack');
  assert.equal(ok.ok, true, ok.ok ? '' : `${ok.error}: ${ok.detail}`);
  assert.equal(ok.pack.target, 'stardust');
  assert.equal(ok.pack.type, 'mod');
  assert.deepEqual(ok.pack.capabilities, ['skins'], '去重且排序');

  const noType = norm(star({ type: undefined }), 'sd-pack');
  assert.equal(noType.ok, false);
  assert.equal(noType.error, 'STARDUST_TARGET_BAD_TYPE');

  const badCaps = norm(star({ capabilities: ['Skins'] }), 'sd-pack');
  assert.equal(badCaps.ok, false);
  assert.equal(badCaps.error, 'STARDUST_TARGET_BAD_CAPABILITIES');

  // Stardust profile 自己的拼法：放行它们只为一件事 —— 同一份 pack.json 两端各自读得懂
  const spelling = norm(star({ authors: ['a'], englishName: 'x', app: '>=1' }), 'sd-pack');
  assert.equal(spelling.ok, true, spelling.ok ? '' : `${spelling.error}: ${spelling.detail}`);
  // 能力认领的字段只跟着声明过的能力走
  const claimed = norm(star({ capabilities: ['announcements'], announcements: [{ title: 't' }] }), 'sd-pack');
  assert.equal(claimed.ok, true, claimed.ok ? '' : `${claimed.error}: ${claimed.detail}`);
  const unclaimed = norm(star({ announcements: [{ title: 't' }] }), 'sd-pack');
  assert.equal(unclaimed.ok, false, '没声明 announcements 能力却写了那个字段 ⇒ 仍然点名拒绝');
  assert.equal(unclaimed.error, 'PACK_UNKNOWN_FIELD');
});

test('④ 装载器：stardust 包进 `foreign`（具名），不进 packs / errors / 目录；forge 包一字未变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-'));
  try {
    const write = (id, manifest, extra = {}) => {
      const d = path.join(dir, id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'pack.json'), `${JSON.stringify({ id, ...manifest }, null, 2)}\n`);
      for (const [f, body] of Object.entries(extra)) fs.writeFileSync(path.join(d, f), body);
    };
    write('forge-pack', { name: 'f', version: '1.0.0', license: 'CC0-1.0', content: ['items'] },
      { 'items.json': JSON.stringify({ forge_item_a: { id: 'forge_item_a', name: 'x', tier: 1 } }) });

    const logs = [];
    const log = { warn: (m) => logs.push(`WARN ${m}`), info: (m) => logs.push(`INFO ${m}`), error: (m) => logs.push(`ERROR ${m}`) };
    const before = loadWorkshop(dir, { log: { warn() {}, info() {}, error() {} } });
    assert.deepEqual(before.packs.map((p) => p.id), ['forge-pack']);
    assert.deepEqual(before.errors, []);
    assert.deepEqual(before.foreign, [], '没有 stardust 包时 foreign 是空表，不是 undefined');
    const catalogBefore = buildModCatalog(before);

    write('sd-pack', { name: 'sd', version: '1.0.0', license: 'CC0-1.0', target: 'stardust', type: 'mod', capabilities: [] });
    const after = loadWorkshop(dir, { log });
    assert.deepEqual(after.errors, [], 'stardust 包不是错误：它是一条具名的 foreign');
    assert.deepEqual(after.packs.map((p) => p.id), ['forge-pack'], '只有 forge 包进 packs');
    assert.deepEqual(after.foreign.map((f) => f.pack), ['sd-pack']);
    assert.match(after.foreign[0].reason, /declaration-only, loaded by the Stardust host/);
    assert.ok(logs.some((l) => l.startsWith('INFO ') && l.includes('sd-pack')), '装载器必须留下一行具名日志');
    // 放一个 stardust 包，对 forge 包的身份与目录**逐字节**没有影响
    assert.equal(sha256Hex(canonicalJson(buildModCatalog(after))), sha256Hex(canonicalJson(catalogBefore)),
      'forge 包的目录摘要一字未变');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 跨宿主误用：stardust 包**不在** /mods/catalog.json 里（如实钉住，这一条是已知的「半可用」面）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-'));
  try {
    fs.mkdirSync(path.join(dir, 'sd-pack'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sd-pack', 'pack.json'), `${JSON.stringify({ id: 'sd-pack', name: 'sd', version: '1.0.0', license: 'CC0-1.0', target: 'stardust', type: 'mod', capabilities: [] }, null, 2)}\n`);
    const loaded = loadWorkshop(dir, { log: { warn() {}, info() {}, error() {} } });
    assert.deepEqual(loaded.foreign.map((f) => f.pack), ['sd-pack']);
    assert.deepEqual(buildModCatalog(loaded).packs.map((p) => p.id), [],
      'stardust 包不进目录 ⇒ 客户端看不到它。具名日志是服务端那一侧的唯一信号');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ⑤ 三面接线（业主裁定 2026-10-12）：`foreign` 必须**响亮** ----------------------------------------------
//
// 「接受但不装载」如果只在启动日志里说一句，作者可见的三个面（校验器 / 管理器 CLI / 编辑器）就都是静默的：
// 包在磁盘上、在列表里、却永远进不了游戏而没有任何说明 —— 正是 docs/WORKSHOP.md §1.1 那条教训的形状
//（`content` 没声明 `chess` ⇒ 编辑器里在、磁盘上在、永远进不了游戏、没有任何报错）。
// 下面三条钉住：三个面都必须**点名**它，而且都要说得出**为什么**（不是 `REFUSED（null）`）。

/** 一个只装着 stardust 包的 workshop 目录（三条接线测试共用）。 */
function starFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-target-wire-'));
  fs.mkdirSync(path.join(dir, 'sd-pack'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sd-pack', 'pack.json'),
    `${JSON.stringify({ id: 'sd-pack', name: 'sd', version: '1.0.0', license: 'CC0-1.0', target: 'stardust', type: 'mod', capabilities: [] }, null, 2)}\n`);
  return dir;
}

const runCli = (script, argv) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...argv], { encoding: 'utf8', timeout: 180000 });

test('⑤ 接线①校验器：stardust 包在报告里**具名**（PACK_FOREIGN warning），不是「一行都不提」', () => {
  const dir = starFixture();
  try {
    const json = runCli('workshop-validate.mjs', [dir, '--json']);
    assert.equal(json.status, 0, `它是 warning 不是 error ⇒ 退出码仍是 0（stderr: ${json.stderr}）`);
    const report = JSON.parse(json.stdout);
    const row = report.packs.find((p) => p.pack === 'sd-pack');
    assert.ok(row, 'stardust 包必须在报告里出现 —— 从报告里消失 = 作者看到的只有「我建的包不见了」');
    const issue = row.issues.find((i) => i.code === 'PACK_FOREIGN');
    assert.ok(issue, '必须有一条 PACK_FOREIGN');
    assert.equal(issue.severity, 'warning', '清单是合法的 ⇒ 不是 error');
    assert.match(issue.message, /Stardust host/, '理由要说清它是给哪个宿主的');
    assert.deepEqual(report.foreign, [{ pack: 'sd-pack', reason: issue.message }], '--json 另外给一份按包 id 直接查的列表');

    const text = runCli('workshop-validate.mjs', [dir]);
    assert.match(text.stdout, /sd-pack/);
    assert.match(text.stdout, /PACK_FOREIGN/);
    assert.match(text.stdout, /Stardust host/);
    assert.match(text.stdout, /1 warning/, '它计入 warning');
    assert.match(text.stdout, /NOTE: 1 pack\(s\) target another host/, '收尾那句要说清「接受 ≠ 装载」');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 接线②管理器 list：`REFUSED（null）` 变成具名的 `FOREIGN（本引擎不装载：…）`，reason 有值', () => {
  const dir = starFixture();
  try {
    const json = runCli('workshop-pack.mjs', ['list', '--workshop', dir, '--json']);
    const body = JSON.parse(json.stdout);
    const p = body.packs.find((x) => x.id === 'sd-pack');
    assert.ok(p, '列表里必须有它');
    assert.equal(p.status, 'foreign', '既不是 loaded 也不是 refused');
    assert.equal(typeof p.reason, 'string', 'reason 必须有值 —— 从前的 `REFUSED（null）` 就是这一处为 null');
    assert.match(p.reason, /Stardust host/);
    assert.equal(p.refusal.code, 'PACK_FOREIGN');

    const text = runCli('workshop-pack.mjs', ['list', '--workshop', dir]);
    assert.match(text.stdout, /FOREIGN（本引擎不装载：/);
    assert.match(text.stdout, /Stardust host/);
    assert.doesNotMatch(text.stdout, /REFUSED（null）/, '这个字符串本身就是那个缺陷');
    assert.doesNotMatch(text.stdout, /REFUSED（/, 'stardust 包不是「被拒」：用词要分开');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 接线③编辑器：包管理页拿到的是 `foreign` + 同一句原因（不是 refused / null）', async () => {
  const dir = starFixture();
  let editor = null;
  try {
    editor = await createEditorServer({ workshopRoot: dir, port: 0, host: '127.0.0.1', dataDir: DATA_DIR, supportFile: path.join(dir, 'support.json') });
    const body = await fetch(`${editor.url}/api/packs/support`).then((r) => r.json());
    const p = (body.packs ?? []).find((x) => x.id === 'sd-pack');
    assert.ok(p, '编辑器必须列出它 —— 列表里消失 = 作者唯一能看到的结论是「我的包不见了」');
    assert.equal(p.status, 'foreign');
    assert.match(p.reason, /Stardust host/);
    assert.equal(p.refusal.code, 'PACK_FOREIGN');
    assert.match(p.refusal.detail, /Stardust host/);
  } finally {
    await editor?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 接线③编辑器：**渲染层**真的把 foreign 说出来（这一条有牙，接口对不代表页面说）', () => {
  // 上面那条只走到 `/api/packs/support`：接口对了，页面照样可以把 `foreign` 当成 `refused` 显示、甚至整行不显示。
  // `editor/ui/pack.js` 是页面脚本（顶层就跑 `load()` / `mountI18n()`），在 node 里 import 不起来，所以这里对
  // **源码**立契约 —— 与 test/editorI18n.test.js 检查「源码与词典一致」同一路数：两个渲染分支必须都在，
  // 且文案必须走 `t('…')` 单引号（反引号写法不在 i18n 扫描范围内，会被判死键、译文也不生效）。
  const src = fs.readFileSync(path.join(ROOT, 'editor', 'ui', 'pack.js'), 'utf8');
  const list = src.slice(src.indexOf('function renderPackList'), src.indexOf('function renderDetail'));
  assert.match(list, /p\.status === 'foreign'/, '列表行必须单独认 foreign（否则它落进「已被拒绝」那一支，用词就错了）');
  assert.match(list, /t\('本引擎不装载它：\{0\}'/, '列表行文案要走单引号 t()');
  assert.doesNotMatch(list, /t\(`/, '反引号写法不算数：i18n 扫描器看不见它 ⇒ 死键 + 英文页留在中文');

  const detail = src.slice(src.indexOf('function renderDetail'));
  assert.match(detail, /p\.status === 'foreign'/, '详情页也必须单独认 foreign');
  assert.match(detail, /banner warn/, '用 warn 而不是 bad —— 清单合法，作者没写错任何东西');
  assert.match(detail, /t\('⚠ 本引擎不装载这个包：\{0\}/, '详情页文案要走单引号 t()');
  assert.doesNotMatch(detail, /t\(`/, '详情页同样不许用反引号');

  // 两条文案都要在英文词典里（`t()` 查不到就原样返回中文，英文页会静默留在中文）。
  const en = fs.readFileSync(path.join(ROOT, 'editor', 'ui', 'i18n.en.pack.js'), 'utf8');
  for (const key of ['本引擎不装载它：{0}', '⚠ 本引擎不装载这个包：{0}。它不是错误 —— pack.json 是合法的，只是这一份清单是给另一个宿主的。']) {
    assert.ok(en.includes(key), `英文词典缺这一条：${key}`);
  }
});
