// test/modClientSettings.test.js — C 层面板注入面的第二批（DESIGN §28.31 / §28.32），外加伤害看板那一格的可执行结论。
//
// 三件事在这里被钉住，每一件都必须是**能证伪的判据**，不是「字段存在」：
//
//   1. `ctx.me.voice`（§28.31）：`{ global, byChar }`，**每次读一份新的冻结副本**；引擎之后的选择变化不回溯改写
//      已发出的那一份；面板改它当场 `TypeError`；**没有注入设置库 ⇒ `null`**（不抛、不编造）。byChar 是**第二个
//      读者**：store 里形状不对的键 / 不在 `VOICE_LANGS` 里的值不进快照。
//   2. `ctx.session.setVoiceLang(charId, lang)`（§28.31）：闭枚举（`VOICE_LANGS` 的成员 + `''` / `null` = 清覆盖），
//      越界**点名拒绝**（`CLIENT_VOICE_*`）而不是静默丢掉；**只改 `voiceLangByChar` 一格**，其它设置逐字节不变；
//      落盘走设置库那**一条**既有订阅（`sp.pref.settings`）。`undefined` 不是清空 —— 那一格要写明 `''`。
//   3. `ctx.net.transport()`（§28.32）：读的就是 `welcome.transport`（服务端那一格）；**缺字段 ⇒ `null` 并记一行**
//      （每种原因一次），**不造默认值**；`maxPayload` 不成形 ⇒ **整格 `null`**（半个读数比没有更危险）。
//
// 外加两条与「伤害看板」直接有关的可执行结论（本文件不新增任何实现，只把今天的事实钉住）：
//   * `m.result` 是既有 S2C 成员，`ctx.net.on('m.result')` **原样透传** ⇒ 总伤（`players[].stats.dmgDealt` /
//     `bossDamage`）今天就能读；但它**不带逐单位 / 逐场伤害**（所以拿它算不出逐单位 DPS —— 这条断言就是给
//     作者的边界，不许以为今天能拿）；
//   * 默认（客户端跑战斗）时伤害元组**不进 `net`**：`public/js/battle/runner.js` 的 `emit` 是它自己的 listener
//     map（源码级断言），`b.ev` 只在服务端跑战斗的 legacy 路径上才有。
//   * 「模拟侧零副作用」：同一场战斗（同 seed、同数据）在**面板注册点活着、面板订阅并消费了伤害帧**的情况下跑，
//     与没有面板时跑，`result()` 的摘要**逐字节相同**。
//
// Run: node --test test/modClientSettings.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Net } from '../public/js/net.js';
import { S2C, C2S, EV } from '../shared/protocol.js';
import { VOICE_LANGS, DEFAULT_VOICE_LANG } from '../shared/constants.js';
import { createStore, initialState } from '../public/js/store.js';
import { createPanelRegistry, VOICE_CHAR_ID_RE } from '../public/js/ui/extensions.js';
import { makeBattle, chessRec, enemyRec, hashOf } from './helpers/battleHarness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const wire = (over = {}) => ({
  id: 'p1', pack: 'alpha', slot: 'root.overlays',
  url: '/workshop-panels/alpha/p1.js?v=0123456789ab', order: 0, gate: null, requires: [], ...over,
});

function mkEl(tag) {
  return {
    tag, className: '', attributes: {}, children: [], style: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}

/**
 * 一个假的 `net`：订阅表 + **四个出口的计数器**（`send` / `request` / `sendResourceMessage` / `_sendRaw`）。
 * 读面一个出口都不许碰 —— 与 `test/modClientNetReads.test.js` 对真 `Net` 做的是同一件事，这里要的是
 * 「窗口 / 配音 / 传输」三格一起读的时候也一样」。
 */
function fakeNet() {
  const handlers = new Map();
  const calls = { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 };
  return {
    calls,
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    emit(type, msg) { for (const fn of [...(handlers.get(type) || [])]) fn({ t: type, ...msg }); },
    handlers,
    send() { calls.send += 1; return true; },
    request() { calls.request += 1; return Promise.resolve({ t: 'ok' }); },
    sendResourceMessage() { calls.sendResourceMessage += 1; return true; },
    _sendRaw() { calls._sendRaw += 1; return true; },
  };
}

/** 一个可写的设置桩：`get()` 返回当前值，`setVoiceLang` 记下写入并（可选）拒绝。 */
function settingsStub(initial = {}) {
  let state = {
    bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, workshopSkins: true,
    quality: 'high', textSize: 'sm', keys: { refresh: 'R' }, voiceLang: 'jp', voiceLangByChar: { char_a: 'kr' },
    ...initial,
  };
  const writes = [];
  return {
    writes,
    state: () => state,
    get: () => state,
    setVoiceLang(charId, lang) {
      writes.push([charId, lang]);
      const next = { ...state.voiceLangByChar };
      if (lang === '') delete next[charId]; else next[charId] = lang;
      state = { ...state, voiceLangByChar: next };
      return true;
    },
  };
}

/** 造一个注册点、挂一个面板、把它的 `ctx` 还给你（`deps` 可覆盖 `settings` 那一格）。 */
async function ctxOf({ net = fakeNet(), settings, extra = {} } = {}) {
  const seen = [];
  const registry = createPanelRegistry({
    store: createStore({ ...initialState }), net, log: quiet,
    ...(settings === undefined ? {} : { settings }),
    importModule: async () => ({ mount: (ctx) => { seen.push(ctx); } }),
    slotHost: () => mkEl('div'), createElement: mkEl,
    env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
    ...extra,
  });
  registry.apply([wire()]);
  await settle();
  assert.equal(seen.length, 1, '面板挂上了');
  return { registry, ctx: seen[0], net };
}

// ---------------------------------------------------------------------------------------------------------------
describe('§28.31 ctx.me.voice：面板读不到的「这台机器用哪套配音」', () => {
  test('形状 `{ global, byChar }`：每次读一份新的冻结副本，读的就是设置库当前的值', async () => {
    const settings = settingsStub({ voiceLang: 'jp', voiceLangByChar: { char_a: 'kr', char_b: 'en' } });
    const { ctx } = await ctxOf({ settings });

    const v = ctx.me.voice;
    assert.deepEqual({ ...v }, { global: 'jp', byChar: { char_a: 'kr', char_b: 'en' } });
    assert.ok(Object.isFrozen(v), '冻结');
    assert.ok(Object.isFrozen(v.byChar), 'byChar 也冻结（深一层）');
    assert.equal(v.global, DEFAULT_VOICE_LANG === 'jp' ? 'jp' : 'jp', 'global 是设置库里的 voiceLang');

    // 引擎之后换了一次选择：已经发出去的那一份一个字都不许变，下一次读是新的一份
    const first = v;
    settings.state().voiceLang = 'kr';
    settings.state().voiceLangByChar = { char_a: 'cn' };
    assert.deepEqual({ ...first }, { global: 'jp', byChar: { char_a: 'kr', char_b: 'en' } }, '内部变了，已发出的快照不变');
    const second = ctx.me.voice;
    assert.notEqual(second, first, '每次调用一份新的副本');
    assert.deepEqual({ ...second }, { global: 'kr', byChar: { char_a: 'cn' } });
    // 面板改它 / 改引擎那份：两个方向都当场失败
    assert.throws(() => { second.global = 'cn'; }, TypeError);
    assert.throws(() => { second.byChar.char_a = 'jp'; }, TypeError);
    assert.equal(settings.state().voiceLang, 'kr', '面板改不动引擎的设置');
  });

  test('第二个读者：形状不对的键 / 不在 VOICE_LANGS 里的值不进快照（面板画的不许与播放的不一致）', async () => {
    const settings = settingsStub({
      voiceLang: 'cn',
      // 一个手改过的 localStorage / 一个坏 store：只有 char_b 那一格是合法的
      voiceLangByChar: { char_b: 'jp', 'x/y': 'kr', char_c: 'zz', char_d: 7, char_e: null },
    });
    const { ctx } = await ctxOf({ settings });
    assert.deepEqual({ ...ctx.me.voice }, { global: 'cn', byChar: { char_b: 'jp' } });
    // 全局值本身坏了 ⇒ global 是 null（不是编一个默认配音出来）
    settings.state().voiceLang = 'zz';
    assert.deepEqual({ ...ctx.me.voice }, { global: null, byChar: { char_b: 'jp' } });
    assert.deepEqual([...VOICE_LANGS], ['cn', 'jp', 'en', 'kr'], '这一格没有改动词表本身');
  });

  test('拿不到就是 null：没注入设置库 / 设置库不成形 / 它自己炸（不抛、不编造）', async () => {
    const cases = [
      ['没有 settings', undefined],
      ['settings 是 null', null],
      ['没有 get', {}],
      ['get 返回 null', { get: () => null }],
      ['get 返回标量', { get: () => 42 }],
      ['get 自己炸', { get: () => { throw new Error('boom'); } }],
    ];
    for (const [note, settings] of cases) {
      const { ctx } = await ctxOf({ settings });
      assert.equal(ctx.me.voice, null, `拿不到就是 null：${note}`);
      // 会话态那三格不因此坏掉：一格读不到不是「整个 me 没了」
      assert.equal(ctx.me.playerId, null);
      assert.deepEqual({ ...ctx.me.snapshot() }, { playerId: null, name: null, room: null });
    }
  });

  test('voice 不进 snapshot()：那三格来自一次 `store.get()`，这一格来自另一个 store', async () => {
    const { ctx } = await ctxOf({ settings: settingsStub() });
    assert.deepEqual(Object.keys({ ...ctx.me.snapshot() }).sort(), ['name', 'playerId', 'room']);
    assert.ok(ctx.me.voice, '读得到配音');
    assert.equal(ctx.me.store, undefined, '门面上仍然没有 store 句柄');
  });
});

describe('§28.31 ctx.session.setVoiceLang：唯一一格面板能写的设置', () => {
  test('闭枚举：四个配音都能写；`\'\'` / `null` 清掉覆盖；写入只碰这一格', async () => {
    const settings = settingsStub({ voiceLang: 'jp', voiceLangByChar: {} });
    const { ctx, registry } = await ctxOf({ settings });
    const keysBefore = Object.keys(settings.state()).sort();
    const othersBefore = JSON.stringify(Object.fromEntries(Object.entries(settings.state()).filter(([k]) => k !== 'voiceLangByChar')));

    for (const lang of VOICE_LANGS) {
      assert.equal(ctx.session.setVoiceLang('char_a', lang), true, `写 ${lang}`);
      assert.equal(settings.state().voiceLangByChar.char_a, lang);
    }
    assert.deepEqual(settings.writes.map((w) => w[1]), [...VOICE_LANGS], '写下去的就是那四个值（没有转换、没有编造）');

    assert.equal(ctx.session.setVoiceLang('char_a', ''), true, '清空');
    assert.equal(Object.hasOwn(settings.state().voiceLangByChar, 'char_a'), false, '覆盖被删掉 = 回到跟随全局');
    assert.equal(ctx.session.setVoiceLang('char_b', 'kr'), true);
    assert.equal(ctx.session.setVoiceLang('char_b', null), true, 'null 也是清空');
    assert.equal(Object.hasOwn(settings.state().voiceLangByChar, 'char_b'), false);

    // **只碰这一格**：别的设置逐字节不变，键集也不变
    assert.deepEqual(Object.keys(settings.state()).sort(), keysBefore);
    assert.equal(JSON.stringify(Object.fromEntries(Object.entries(settings.state()).filter(([k]) => k !== 'voiceLangByChar'))), othersBefore);
    assert.deepEqual(registry.refusals(), [], '一路都没拒绝过');
  });

  test('越界一律**点名拒绝**并返回 false，不是静默丢弃', async () => {
    const settings = settingsStub({ voiceLangByChar: { char_a: 'kr' } });
    const { ctx, registry } = await ctxOf({ settings });

    const bad = [
      ['非枚举的配音', 'char_a', 'zz', 'CLIENT_VOICE_BAD_LANG'],
      ['多余参数形态', 'char_a', 'CN', 'CLIENT_VOICE_BAD_LANG'],
      ['对象', 'char_a', { lang: 'cn' }, 'CLIENT_VOICE_BAD_LANG'],
      ['数字', 'char_a', 1, 'CLIENT_VOICE_BAD_LANG'],
      ['undefined 不是「清空」', 'char_a', undefined, 'CLIENT_VOICE_BAD_LANG'],
      ['干员 id 形状不对', 'x/y', 'cn', 'CLIENT_VOICE_BAD_CHAR'],
      ['干员 id 太短', 'char_', 'cn', 'CLIENT_VOICE_BAD_CHAR'],
      ['干员 id 不是字符串', 7, 'cn', 'CLIENT_VOICE_BAD_CHAR'],
      ['干员 id 太长', `char_${'a'.repeat(65)}`, 'cn', 'CLIENT_VOICE_BAD_CHAR'],
    ];
    for (const [note, charId, lang, code] of bad) {
      const n = registry.refusals().length;
      assert.equal(ctx.session.setVoiceLang(charId, lang), false, `拒绝：${note}`);
      const added = registry.refusals().slice(n);
      assert.equal(added.length, 1, `点名一次：${note}`);
      assert.equal(added[0].code, code, note);
      assert.match(added[0].detail, /setVoiceLang/, '拒绝里点了这个调用');
      assert.deepEqual(settings.writes, [], `一个字节都没写：${note}`);
    }
    // 语言那一格被点名时**列出全部可用配音**（作者当场知道该写什么）
    const lang = registry.refusals().find((r) => r.code === 'CLIENT_VOICE_BAD_LANG');
    for (const l of VOICE_LANGS) assert.match(lang.detail, new RegExp(`\\b${l}\\b`), `列出 ${l}`);
    assert.match(lang.detail, /clear this operator's override/, '也说清怎么写「清空」');
    assert.equal(settings.state().voiceLangByChar.char_a, 'kr', '原来的覆盖原样');
  });

  test('没有注入设置库 ⇒ 点名拒绝（不是「写了个没反应的东西」）', async () => {
    for (const settings of [undefined, null, {}, { get: () => null }]) {
      const { ctx, registry } = await ctxOf({ settings });
      assert.equal(ctx.me.voice, null, '读数也是 null');
      assert.equal(ctx.session.setVoiceLang('char_a', 'cn'), false, '写口拒绝');
      assert.equal(registry.refusals().at(-1).code, 'CLIENT_VOICE_NO_SETTINGS');
    }
  });

  test('设置库自己拒绝时（例如覆盖表满 400）C 层照样点名，而不是以为写成功了', async () => {
    let refused = 0;
    const settings = {
      get: () => ({ voiceLang: 'cn', voiceLangByChar: {} }),
      setVoiceLang: () => { refused += 1; return false; },
    };
    const { ctx, registry } = await ctxOf({ settings });
    assert.equal(ctx.session.setVoiceLang('char_a', 'jp'), false);
    assert.equal(refused, 1, '写了（只是被拒）');
    assert.equal(registry.refusals().at(-1).code, 'CLIENT_VOICE_REFUSED');
  });
});

describe('§28.31 真设置库：setVoiceLangByChar 的边界与落盘（真实 store + 真实 savePref）', () => {
  /** 真 `ui/settings.js` + 一个 localStorage 桩（`loadPref` / `savePref` 读的就是它）。 */
  async function realSettings() {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    };
    const mod = await import('../public/js/ui/settings.js');
    return { mod, mem };
  }

  test('只改 voiceLangByChar 一格；别的设置在 store 与落盘里逐字节不变', async () => {
    const { mod, mem } = await realSettings();
    const { settingsStore, updateSettings, setVoiceLangByChar } = mod;
    updateSettings({ voiceLangByChar: {}, bgm: 0.42, muted: true, quality: 'low' });
    const before = settingsStore.get();
    const othersBefore = JSON.stringify(Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'voiceLangByChar')));

    assert.equal(setVoiceLangByChar('char_a', 'jp'), true);
    assert.deepEqual({ ...settingsStore.get().voiceLangByChar }, { char_a: 'jp' });
    assert.deepEqual(settingsStore.get().voiceLang, before.voiceLang, '全局配音不动');
    assert.equal(JSON.stringify(Object.fromEntries(Object.entries(settingsStore.get()).filter(([k]) => k !== 'voiceLangByChar'))), othersBefore, '别的设置逐字节不变');

    // 落盘：同一条既有订阅（`settingsStore.subscribe` → `savePref('settings', …)`）
    const saved = JSON.parse(mem.get('sp.pref.settings'));
    assert.deepEqual(saved.voiceLangByChar, { char_a: 'jp' });
    assert.equal(saved.bgm, 0.42);
    assert.equal(saved.muted, true);

    // 清空也走同一条路
    assert.equal(setVoiceLangByChar('char_a', ''), true);
    assert.deepEqual({ ...settingsStore.get().voiceLangByChar }, {});
    assert.deepEqual(JSON.parse(mem.get('sp.pref.settings')).voiceLangByChar, {});

    // 边界：形状不对的 id / 不在词表里的语言 —— 函数自己拒绝，store 一个字节不变
    const afterClear = JSON.stringify(settingsStore.get());
    assert.equal(setVoiceLangByChar('x/y', 'cn'), false);
    assert.equal(setVoiceLangByChar('char_z', 'zz'), false);
    assert.equal(setVoiceLangByChar('char_z', 'CN'), false);
    assert.equal(JSON.stringify(settingsStore.get()), afterClear, '被拒 = 一个字节都没写');

    // 覆盖表满（`VOICE_OVERRIDE_MAX` = 400）时第 401 个被拒 —— 这一条只有引擎知道，所以 C 层那格要点名
    const full = {};
    for (let i = 0; i < 400; i++) full[`char_f${i}`] = 'cn';
    updateSettings({ voiceLangByChar: full });
    assert.equal(setVoiceLangByChar('char_overflow', 'jp'), false, '第 401 个被拒');
    assert.equal(Object.keys(settingsStore.get().voiceLangByChar).length, 400);
  });

  test('钉住：`VOICE_CHAR_ID_RE`（C 层）与 `sanitizeVoiceLangByChar`（设置库）对同一个 id 说同一句话', async () => {
    const { mod } = await realSettings();
    const { settingsStore, updateSettings, setVoiceLangByChar } = mod;
    // 设置库是**模块级单例**（上一个用例把覆盖表填满过）：先清干净，否则这条钉子的失败原因会是「表满了」
    updateSettings({ voiceLangByChar: {} });
    const ids = ['char_a', 'char_1_01_a', 'char_' + 'a'.repeat(64), 'char_', 'char', 'Char_a', 'char_a-b', 'char_a b', 'char_a/b', `char_${'a'.repeat(65)}`, '', 'x/y'];
    for (const id of ids) {
      const mine = VOICE_CHAR_ID_RE.test(id);
      // 设置库那一边：把它当键写进去，看它有没有活下来（`sanitizeVoiceLangByChar` 就是那条判据）
      const ok = setVoiceLangByChar(id, 'jp');
      assert.equal(ok, mine, `两处判据对 "${id}" 必须一致（C 层 ${mine} / 设置库 ${ok}）`);
      // 收尾：写进去的清掉，别把状态留给下一个 id
      if (ok) setVoiceLangByChar(id, '');
    }
    assert.deepEqual({ ...settingsStore.get().voiceLangByChar }, {}, '收尾干净');
  });
});

describe('§28.32 ctx.net.transport()：只有服务端知道的那一格', () => {
  /** 一帧真形状的 `welcome`（`server/net.js` 的 `welcomeInfo()` 那一份 + 服务端那一批新加的 `transport`）。 */
  const WELCOME = (transport) => ({
    t: 'welcome', playerId: 'p1', token: 'tok-1', name: '甲', serverNow: 1_000_000, version: '0.2.4',
    ...(transport === undefined ? {} : { transport }),
  });
  const GOOD = { deflate: true, params: 'client_max_window_bits=15; server_no_context_takeover', maxPayload: 65536, threshold: 1024 };

  test('读到的就是 `welcome.transport` 的那四个键，冻结、每次读一份新的', async () => {
    const { ctx, net } = await ctxOf();
    const transport = {
      deflate: true, params: 'server_no_context_takeover', maxPayload: 1 << 20, threshold: 0,
      // 服务端那一格里多带的字段不外传（这一格只有四个键）
      unknown: 'x',
    };
    net.emit('welcome', WELCOME(transport));
    const t = ctx.net.transport();
    assert.deepEqual({ ...t }, { deflate: true, params: 'server_no_context_takeover', maxPayload: 1 << 20, threshold: 0 });
    assert.equal(t.unknown, undefined, '只带那四个键');
    assert.ok(Object.isFrozen(t), '冻结');
    // 后到的一帧不回溯改写已发出的那一份；下一次读是新的一份
    net.emit('welcome', WELCOME({ deflate: false, maxPayload: 4096 }));
    assert.deepEqual({ ...t }, { deflate: true, params: 'server_no_context_takeover', maxPayload: 1 << 20, threshold: 0 });
    assert.deepEqual({ ...ctx.net.transport() }, { deflate: false, params: null, maxPayload: 4096, threshold: null });
    assert.throws(() => { t.maxPayload = 1; }, TypeError);
    // 与 welcome() 是**同一条事实**：同一帧的只读快照
    assert.equal(ctx.net.welcome().transport.maxPayload, 4096);
  });

  test('「不知道」与「关着」分开：读不到的字段是 null，不是 false / \'\' / 0', async () => {
    const { ctx, net } = await ctxOf();
    net.emit('welcome', WELCOME({ maxPayload: 4096, deflate: null, params: '', threshold: null }));
    const t = ctx.net.transport();
    assert.equal(t.deflate, null, 'null 不是 false');
    assert.equal(t.params, '', '空串是服务端自己给的字符串，原样给出去');
    assert.equal(t.threshold, null);
    net.emit('welcome', WELCOME({ maxPayload: 0, deflate: 'yes', params: 5, threshold: 'x' }));
    const t2 = ctx.net.transport();
    assert.deepEqual({ ...t2 }, { deflate: null, params: null, maxPayload: 0, threshold: null }, '不成形的字段归 null，不硬转');
  });

  test('拿不到 ⇒ null：没收到 welcome（不记）· 没有 transport 字段（记一行）· maxPayload 不成形（整格 null）', async () => {
    // ① 还没有任何 welcome：null，而且**不记**（那是「还没到时候」）
    const logs = [];
    const { ctx, net, registry } = await ctxOf({ extra: { log: { info() {}, warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } } });
    assert.equal(ctx.net.transport(), null, '没有 welcome ⇒ null');
    assert.equal(ctx.net.welcome(), null);
    assert.deepEqual(logs, [], '「还没到时候」不是缺字段，不记日志');
    assert.deepEqual(registry.refusals(), [], '也不是一条拒绝');

    // ② 收到了 welcome，但它没有 transport 字段（老服务器 / 未装服务端那一格）：null + **一行**（读很多次也只有一行）
    net.emit('welcome', WELCOME(undefined));
    for (let i = 0; i < 5; i++) assert.equal(ctx.net.transport(), null, '缺字段 ⇒ null（不编造默认值）');
    assert.equal(logs.filter((l) => l.includes('CLIENT_TRANSPORT_UNAVAILABLE')).length, 1, '每种原因只记一行');
    assert.match(logs.join('\n'), /absent/, '记的原因是可读的');
    assert.match(logs.join('\n'), /server side of this cell/, '如实标注「待服务端补字段」');

    // ③ transport 在，但 maxPayload 不成形：整格 null（半个读数比没有更危险）+ 一行
    net.emit('welcome', WELCOME({ deflate: true, params: 'x', maxPayload: '65536', threshold: 1 }));
    assert.equal(ctx.net.transport(), null, 'maxPayload 不是有限非负数 ⇒ 整格 null');
    net.emit('welcome', WELCOME({ deflate: true, maxPayload: -1 }));
    assert.equal(ctx.net.transport(), null, '负数也不行');
    assert.equal(logs.filter((l) => l.includes('CLIENT_TRANSPORT_UNAVAILABLE')).length, 2, '第二种原因各记一行');
  });

  test('真 `Net`：三格读数（status / welcome / transport）一次都不碰四个出口', async () => {
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
      send(s) { this.sent.push(JSON.parse(s)); }
      close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    }
    const noTimers = { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} };
    const net = new Net({ url: 'ws://test/ws', WebSocket: FakeWS, getToken: () => null, now: () => 1_000_000, timers: noTimers });
    net.connect();
    net.ws.readyState = 1;
    net.ws.onopen?.();
    // 注册点先建（它自己订阅 `welcome`，那一格读面的来源），再让帧到达 —— 与页面里的次序一样
    const { ctx } = await ctxOf({ net });
    net._onMessage(JSON.stringify(WELCOME(GOOD)));
    const calls = { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 };
    for (const name of Object.keys(calls)) {
      const orig = net[name].bind(net);
      net[name] = (...a) => { calls[name] += 1; return orig(...a); };
    }
    const bytes = net.ws.sent.length;
    for (let i = 0; i < 5; i++) { ctx.net.status(); ctx.net.welcome(); ctx.net.transport(); ctx.me.voice; }
    assert.deepEqual(calls, { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 }, '读面是纯读者：一个出口都没碰');
    assert.equal(net.ws.sent.length, bytes, 'socket 上一个字节都没多写');
    assert.deepEqual({ ...ctx.net.transport() }, { deflate: true, params: GOOD.params, maxPayload: 65536, threshold: 1024 });
  });

  test('协议面没被这几格改动：`transport` 只是 `welcome` 里的一个字段，不是新的消息类型', () => {
    assert.ok(S2C.includes('welcome'), 'welcome 仍是既有的 S2C 成员');
    assert.equal(S2C.includes('transport'), false, '`transport` 不是 S2C 消息类型（它是 welcome 里的一格字段）');
    assert.equal('transport' in C2S, false, '也不是 C2S');
  });
});

describe('伤害看板（业主点名那一格）：今天能读什么、读不到什么', () => {
  test('总伤今天就能读：`m.result` 是既有 S2C 成员，`ctx.net.on` 原样透传帧里的伤害数字', async () => {
    const { ctx, net, registry } = await ctxOf();
    const got = [];
    const off = ctx.net.on('m.result', (msg) => got.push(msg));
    assert.equal(typeof off, 'function', '引擎类型照旧原样透传（注册到了 net 上）');
    assert.ok(net.handlers.get('m.result'), '订阅落在 net 的 m.result 上');
    assert.deepEqual(registry.refusals(), [], '没有「未声明的通道」那条拒绝');

    const frame = {
      t: 'm.result', victory: true, roundsPassed: 14, modeId: 'mode_multi_normal', difficulty: 'HARD',
      seed: 7, durationMs: 1_800_000,
      players: [
        { playerId: 'p1', seat: 0, name: '甲', alive: true, mvp: 'chess_char_1_01_a', lineup: [],
          stats: { dmgDealt: 1_234_567, bossDamage: 89_000, kills: 96, healingDone: 12_000, leaks: 3, gold: 58, perfectRounds: 5 } },
        { playerId: 'p2', seat: 1, name: '乙', alive: false, mvp: null, lineup: [],
          stats: { dmgDealt: 980_000, bossDamage: 12_000, kills: 71, healingDone: 0, leaks: 9, gold: 40, perfectRounds: 2 } },
      ],
    };
    net.emit('m.result', frame);
    assert.equal(got.length, 1, '面板收到了这一帧');
    assert.deepEqual(got[0].players.map((p) => p.stats.dmgDealt), [1_234_567, 980_000], '总伤是帧里的原值');
    assert.equal(got[0].players[0].stats.bossDamage, 89_000, '领袖伤害也在（`ui/stats.js` 的战绩页读的就是这两个）');
    // 只读：改它不影响引擎（这一帧本来就是服务端发来的那份对象，引擎不留引用）
    got[0].players[0].stats.dmgDealt = 1;
    assert.equal(frame.players[0].stats.dmgDealt, 1, '真 Net 的处理器拿到的是同一条消息对象；面板改它改不到引擎的状态');
  });

  test('逐单位 / 逐场伤害**不在** `m.result` 上 —— 作者的边界（别以为今天能算逐单位 DPS）', () => {
    const src = readFileSync(join(ROOT, 'server/match/results.js'), 'utf8');
    // 结算帧只带每人的合计（`dmgDealt` / `bossDamage`）与由**服务端内部** unitStats 选出的 mvp id；
    // 逐单位的 dmg/kills/heal（那份 `unitStats`）留在服务端（`ps.stats.unitStats`，只用来选 MVP）。
    assert.match(src, /mvp: mvpOf\(ps, lineup\)/, 'mvp 是一个**选出来的 id**');
    const players = src.slice(src.indexOf('return {\n      playerId: ps.playerId'));
    assert.equal(/unitStats/.test(players), false, '结算帧的每个玩家条目里没有 unitStats');
    // 唯一带伤害元组的 S2C 是 b.ev（EV.DMG），而它是**服务端跑战斗**那条 legacy 通道
    assert.ok(S2C.includes('b.ev') && S2C.includes('b.snap'));
    assert.equal(EV.DMG, 'dmg', 'b.ev 的元组里确实有 dmg 这一种');
    const proto = readFileSync(join(ROOT, 'shared/protocol.js'), 'utf8');
    assert.match(proto, /server-run combat streaming \(legacy \/ SP_COMBAT=server only\)\s*\n\s*'b\.snap', 'b\.ev'/, 'b.ev 的注释自己写着 legacy / SP_COMBAT=server');
  });

  test('实时伤害只有首领回合那一格：`b.pool` 是 S2C（每个客户端都收得到），而 `b.progress` 是 **C2S** —— 面板连订阅都不行', async () => {
    const { ctx, net, registry } = await ctxOf();
    // `b.progress` 是**客户端发**的那条（那场的权威客户端 → 服务器）；服务器只把它折进 m.public / b.pool，
    // **从不原帧广播**。所以面板既收不到它、也不许订阅它（`CLIENT_CHANNEL_UNDECLARED` 点名）。
    assert.equal(S2C.includes('b.progress'), false, 'b.progress 不是 S2C 消息类型');
    assert.equal('b.progress' in C2S, true, '它是 C2S');
    const n = registry.refusals().length;
    const off = ctx.net.on('b.progress', () => {});
    assert.equal(typeof off, 'function', '退订函数照样给（不是一个会炸的东西）');
    assert.equal(registry.refusals().length, n + 1, '但**点名**拒绝，不静默');
    assert.equal(registry.refusals().at(-1).code, 'CLIENT_CHANNEL_UNDECLARED');
    assert.equal(net.handlers.get('b.progress'), undefined, 'net 上一个处理器都没挂');
    // 能读的那一格：`b.pool { hp, max, teamLp, acked }`（`server/match/match/bossRounds.js:382` `_broadcastPool`：发给**每个人**，≤ 4 Hz），
    // `acked[fieldId]` = 那一场累计计入的领袖伤害 —— 这是面板今天能拿到的**实时**伤害数字。
    assert.ok(S2C.includes('b.pool'), 'b.pool 是既有的 S2C 成员');
    let live = 0;
    let hp = null;
    ctx.net.on('b.pool', (msg) => {
      hp = msg.hp;
      live = 0;
      for (const v of Object.values(msg.acked || {})) live += Number(v) || 0;
    });
    net.emit('b.pool', { hp: 12_000, max: 90_000, teamLp: 8, acked: { 'a.1.1.b1': 44_000, 'a.1.1.b2': 31_500 } });
    assert.equal(live, 75_500, '两场的累计领袖伤害都读得到');
    assert.equal(hp, 12_000, '共享池的血量也在同一帧里');
    assert.deepEqual(net.calls, { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 }, '读它不发任何帧');
  });

  test('默认（客户端跑战斗）时伤害元组不进 `net`：runner 的 emit 是它自己的 listener map', () => {
    const src = readFileSync(join(ROOT, 'public/js/battle/runner.js'), 'utf8');
    assert.match(src, /const emit = \(type, payload\) => \{/, 'runner 有自己的一套 emit');
    assert.equal(/net\._emit\(/.test(src), false, 'runner 从不把帧塞进 net 的事件口');
    assert.equal(/\bnet\.emit\(/.test(src), false, '也没有 net.emit');
    // 它对 net 的全部用法：订阅（b.start / b.end …）与 send（b.progress / b.result）—— 都是**入 / 出方向**，
    // 没有一条是「把本地战斗的伤害元组交给面板」
    const netUses = [...src.matchAll(/net\.([A-Za-z_]+)\(/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(netUses)].sort(), ['on', 'request', 'send'], `runner 只对 net 做这三件事（实际：${[...new Set(netUses)].join(', ')}）`);
  });

  test('模拟侧零副作用：面板活着、订阅并消费了伤害帧，同一场战斗的结果摘要逐字节相同', async () => {
    const mk = () => makeBattle({
      defs: {
        chess: { test_chess_a: chessRec({ id: 'test_chess_a', stats: { atk: 900, maxHp: 5000, bat: 1 } }) },
        enemies: { enemy_test: enemyRec({ key: 'enemy_test', hp: 400, atk: 10, bat: 1 }) },
      },
      units: [{ chessId: 'test_chess_a', row: 10, col: 5 }],
      enemies: [{ key: 'enemy_test', time: 0, route: 0, count: 4, interval: 1 }],
      seed: 7, content: 'generic', timeLimit: 60,
    });

    // ① 没有面板：基准
    const plain = mk();
    plain.runToEnd(120);
    const baseResult = plain.result();
    const baseHash = hashOf(baseResult);

    // ② 面板注册点活着：订阅 m.result / b.pool / b.ev，并**真的消费**它们去算一块「伤害看板」
    const damageReads = { reads: 0, dmg: 0, gt: 0 };
    // 这一格（§28.38）由引擎给：这里注入一个**与 runner 同形**的只读读者，确认「面板活着、并且真的读这一格」
    // 也不会动模拟一根毫毛（真正的 runner 读者由 `test/modClientBattleReads.test.js` 单独钉住）
    const battleStub = {
      damage: () => {
        damageReads.reads++;
        return {
          battleId: 'b1', fieldId: 'test', kind: 'normal', authoritative: true, own: true, gt: 3, t0: 0,
          players: [{ playerId: 'p1', dmg: 5_000, bossDmg: 0, kills: 1, heal: 0 }],
          units: [{ id: 1, uid: 7, defId: 'char_a', ownerId: 'p1', kind: 'op', dmg: 5_000, kills: 1, heal: 0 }],
        };
      },
    };
    const { ctx, net } = await ctxOf({ settings: settingsStub({ voiceLang: 'jp', voiceLangByChar: { char_a: 'kr' } }), extra: { battle: battleStub } });
    const board = { total: 0, hits: 0, live: 0, frames: 0, voice: 0 };
    ctx.net.on('m.result', (msg) => { for (const p of msg.players || []) board.total += Number(p.stats?.dmgDealt) || 0; board.frames++; });
    ctx.net.on('b.pool', (msg) => { for (const v of Object.values(msg.acked || {})) board.live = Math.max(board.live, Number(v) || 0); board.frames++; });
    ctx.net.on('b.ev', (msg) => { for (const tuple of msg.ev || []) if (tuple[0] === EV.DMG) { board.hits++; } });
    const battle = mk();
    // 战斗期间面板一直活着、一直读那几格
    battle.run(3);
    net.emit('b.pool', { hp: 1000, max: 5000, teamLp: 4, acked: { 'a.1.1.b1': 1234 } });
    net.emit('b.ev', { fieldId: 'test', gt: 3, ev: [[EV.DMG, 1, 500, 'phys'], [EV.ATK, 1, 2, 'arrow']] });
    net.emit('m.result', { players: [{ playerId: 'p1', stats: { dmgDealt: 5000 } }] });
    for (let i = 0; i < 3; i++) { ctx.me.voice; ctx.net.status(); ctx.net.welcome(); ctx.net.transport(); board.voice++; }
    // §28.38 那一格也一起读、一起消费（DPS = dmg / (gt - t0)）—— 它同样不许碰模拟、不许发帧
    for (let i = 0; i < 3; i++) {
      const d = ctx.battle.damage();
      assert.ok(d, '这一格读得到');
      damageReads.dmg = d.units.reduce((s, u) => s + u.dmg, 0) / Math.max(1e-9, d.gt - d.t0);
      damageReads.gt = d.gt;
    }
    assert.equal(damageReads.reads, 3, '面板真的读了这一格（不是「什么都没发生」的假通过）');
    assert.ok(damageReads.dmg > 0, '按 `dmg / (gt - t0)` 算出的 DPS 非零');
    assert.equal(ctx.session.setVoiceLang('char_a', 'cn'), true, '面板连唯一那格设置也写了');
    battle.runToEnd(120);
    const withPanel = battle.result();

    assert.deepEqual(withPanel, baseResult, '同一场战斗（同 seed、同数据）的结果一字不差');
    assert.equal(hashOf(withPanel), baseHash, '摘要相同 ⇒ 面板这一层摸不到模拟');
    assert.deepEqual(battle.invariants(), true, '不变量也照旧');
    // 面板确实在工作（不是「什么都没发生」的假通过）
    assert.equal(board.hits, 1, '消费到了一条伤害元组');
    assert.equal(board.live, 1234, '实时那一格读到了 b.pool.acked');
    assert.equal(board.total, 5000, '算出的「总伤」就是喂进去的那些数字');
    assert.equal(board.frames, 2);
    assert.equal(board.voice, 3);
    assert.deepEqual(net.calls, { send: 0, request: 0, sendResourceMessage: 0, _sendRaw: 0 }, '这一整套里一个出口都没碰');
  });
});
