// test/modClientHosts.test.js — C 层的**宿主枚举**（业主裁决 2026-10-10：「插进已存在的组件」那一半）。
//
// 0.11.0 的四个槽位都是**浮层**，由注册点按需创建容器。插件包那 21 件要的是另一件事：往**商店卡**加一个标记、
// 给**盟约条**加一个手势、往 **HUD** 加一个角标、在**对局画面**上盖一层、往**干员详情**插一节 —— 容器必须由**组件
// 自己**渲染（`[data-mod-slot]`），否则包得先知道「那张卡在哪」，而那是 store 才能回答的问题（§28.8 不给它）。
//
// 三件必须成立的事，本文件逐条钉：
//   1. **名字是真的**：枚举里每一个「组件渲染的宿主」，`public/js/**` 里都真的有一处渲染它 —— 一个谁也不渲染的
//      挂载点就是「声明了却永远不出现」，那正是这一层到处在拒绝的失败形态（源级扫描，见最后一组）；
//   2. **可重复**：`screen.game.shopCard` 每张卡一个容器，面板挂进**每一个**，`ctx.hostKey` 说明是哪一个；
//      后来才出现的卡在下一次 store 变化时补上；
//   3. **只查不造**：组件还没渲染出来的宿主是「还没到时候」，不记拒绝、不凭空虚造一个容器。
//
// Run: node --test test/modClientHosts.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizePackManifest, CLIENT_PANEL_SLOTS, CLIENT_PANEL_REPEATABLE } from '../shared/workshop.js';
import {
  createPanelRegistry, MOD_PANEL_SLOTS, MOD_PANEL_REPEATABLE, MOD_PANEL_CREATED,
} from '../public/js/ui/extensions.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------------------------
describe('宿主枚举：形状层与客户端两份名单钉在一起', () => {
  test('两份名单逐字相同（少一个 = 客户端拒一个形状层放行的宿主）', () => {
    assert.deepEqual(MOD_PANEL_SLOTS, CLIENT_PANEL_SLOTS);
    assert.deepEqual(MOD_PANEL_REPEATABLE, CLIENT_PANEL_REPEATABLE);
    for (const slot of MOD_PANEL_REPEATABLE) assert.ok(MOD_PANEL_SLOTS.includes(slot), `${slot} 必须在枚举里`);
    for (const slot of MOD_PANEL_CREATED) assert.ok(MOD_PANEL_SLOTS.includes(slot), `${slot} 必须在枚举里`);
    // 两类不重叠：一个宿主要么引擎按需创建，要么组件渲染，不该两者都是
    assert.equal(MOD_PANEL_CREATED.some((s) => !MOD_PANEL_SLOTS.includes(s)), false);
    assert.deepEqual(MOD_PANEL_SLOTS.filter((s) => MOD_PANEL_CREATED.includes(s)).length, 4, '恰好四个浮层是引擎创建的');
  });

  test('枚举之外的 slot 照旧点名拒绝', () => {
    const base = { id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x' };
    const r = normalizePackManifest({ ...base, client: { panels: [{ id: 'p1', slot: 'screen.game.shopcard', module: 'a.js' }] } }, 'p', { hasAssets: false });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'CLIENT_BAD_PANEL_SLOT', '大小写写错也算不在枚举里，理由里会列出九个');
    assert.match(r.detail, /screen\.game\.shopCard/);
    const ok = normalizePackManifest({ ...base, client: { panels: [{ id: 'p1', slot: 'screen.game.shopCard', module: 'a.js' }] } }, 'p', { hasAssets: false });
    assert.equal(ok.ok, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** 够用的假 DOM：宿主容器由测试自己摆（组件渲染的宿主就是这么来的）。 */
const el = (tag, attrs = {}) => ({
  tag, attrs, children: [], className: '',
  setAttribute(k, v) { this.attrs[k] = v; },
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
  appendChild(c) { this.children.push(c); },
  remove() { this.removed = true; },
});

function harness() {
  /** @type {Map<string, any[]>} */
  const hosts = new Map();
  const mountedCtx = [];
  let store = {};
  const listeners = new Set();
  const registry = createPanelRegistry({
    store: {
      get: () => store,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      patch: () => {},
    },
    net: null,
    notify: () => {},
    importModule: async () => ({ mount: (ctx) => { mountedCtx.push(ctx); return {}; } }),
    createElement: (t) => el(t),
    slotHost: () => el('div'),                     // 浮层：按需创建
    slotHosts: (slot) => hosts.get(slot) || [],    // 组件渲染的宿主：只查不造
    styleHost: () => el('head'),
    themeHost: () => el('html'),
    env: { serviceWorker: true, cacheStorage: true, webCrypto: true },
  });
  return {
    registry, mountedCtx, hosts,
    /** 组件渲染出一个容器（可带自己的键）。 */
    addHost(slot, key = null) {
      const node = el('div', key === null ? {} : { 'data-mod-slot-key': key });
      if (!hosts.has(slot)) hosts.set(slot, []);
      hosts.get(slot).push(node);
      return node;
    },
    /** 下一次 store 变化（注册点会在那时重扫一遍容器）。 */
    touch() { store = { ...store, n: (store.n || 0) + 1 }; for (const fn of listeners) fn(); },
  };
}

const panel = (id, slot, extra = {}) => ({ id, pack: 'cardpack', slot, url: `/workshop-panels/cardpack/${id}.js`, ...extra });

describe('可重复宿主：每张商店卡一个容器，面板挂进每一个', () => {
  test('两张卡 ⇒ 挂两次，`ctx.hostKey` 说明是哪一张', async () => {
    const h = harness();
    h.addHost('screen.game.shopCard', 'chess_a');
    h.addHost('screen.game.shopCard', 'chess_b');
    h.registry.apply([panel('marks', 'screen.game.shopCard')]);
    await settle();
    assert.deepEqual(h.registry.mounted(), ['cardpack/marks#chess_a', 'cardpack/marks#chess_b']);
    assert.deepEqual(h.mountedCtx.map((c) => c.hostKey).sort(), ['chess_a', 'chess_b']);
    assert.equal(h.registry.refusals().length, 0);
    for (const ctx of h.mountedCtx) assert.ok(Object.isFrozen(ctx));
  });

  test('后来才出现的第三张卡：下一次 store 变化时补上（不重挂已有的两张）', async () => {
    const h = harness();
    h.addHost('screen.game.shopCard', 'a');
    h.registry.apply([panel('marks', 'screen.game.shopCard')]);
    await settle();
    assert.equal(h.registry.mounted().length, 1);
    h.addHost('screen.game.shopCard', 'b');
    h.touch();
    await settle();
    assert.deepEqual(h.registry.mounted(), ['cardpack/marks#a', 'cardpack/marks#b']);
    assert.equal(h.mountedCtx.length, 2, '已有的那张不重挂');
    h.touch();
    await settle();
    assert.equal(h.mountedCtx.length, 2, '再变一次也不会重复挂');
  });

  test('样式表只注入一份（挂 N 次不等于注入 N 份）', async () => {
    const h = harness();
    h.addHost('screen.game.shopCard', 'a');
    h.addHost('screen.game.shopCard', 'b');
    h.registry.apply([{ ...panel('marks', 'screen.game.shopCard'), styles: [{ path: 'ui/marks.css', url: '/workshop-panels/cardpack/ui/marks.css' }] }]);
    await settle();
    assert.equal(h.registry.mounted().length, 2);
    assert.deepEqual(h.registry.styleUrls(), ['/workshop-panels/cardpack/ui/marks.css']);
  });

  test('dispose 把每一个容器里的面板都撤掉', async () => {
    const h = harness();
    const a = h.addHost('screen.game.shopCard', 'a');
    const b = h.addHost('screen.game.shopCard', 'b');
    h.registry.apply([panel('marks', 'screen.game.shopCard')]);
    await settle();
    assert.equal(a.children.length, 1);
    assert.equal(b.children.length, 1);
    h.registry.dispose();
    assert.equal(a.children[0].removed, true);
    assert.equal(b.children[0].removed, true);
    assert.deepEqual(h.registry.mounted(), []);
  });
});

describe('组件渲染的宿主：只查不造', () => {
  test('容器还没渲染出来 ⇒ 什么都没挂，也**不记拒绝**（那是「还没到时候」）', async () => {
    const h = harness();
    h.registry.apply([panel('hudmark', 'screen.game.hud')]);
    await settle();
    assert.deepEqual(h.registry.mounted(), []);
    assert.deepEqual(h.registry.refusals(), [], '「还没到时候」不是失败，别在控制台里喊');
    h.addHost('screen.game.hud');
    h.touch();
    await settle();
    assert.deepEqual(h.registry.mounted(), ['cardpack/hudmark']);
  });

  test('不可重复的组件宿主：容器出现两个也只挂一次', async () => {
    const h = harness();
    h.addHost('screen.game.hud');
    h.addHost('screen.game.hud');
    h.registry.apply([panel('hudmark', 'screen.game.hud')]);
    await settle();
    assert.deepEqual(h.registry.mounted(), ['cardpack/hudmark'], '不可重复的宿主挂一次就够');
    assert.equal(h.mountedCtx.length, 1);
  });

  test('浮层照旧由引擎按需创建（0.11.0 的行为一个字节不变）', async () => {
    const h = harness();
    h.registry.apply([panel('aside', 'screen.game.aside')]);
    await settle();
    assert.deepEqual(h.registry.mounted(), ['cardpack/aside']);
    assert.equal(h.mountedCtx[0].hostKey, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('枚举里的每个「组件渲染的宿主」都必须真的有人渲染它', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };

  test('`public/js/**` 里找得到 `data-mod-slot="<宿主>"`（否则那个挂载点永远不存在）', () => {
    const files = walk(path.join(ROOT, 'public/js'));
    const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
    const missing = [];
    for (const slot of MOD_PANEL_SLOTS) {
      if (MOD_PANEL_CREATED.includes(slot)) continue;   // 浮层由注册点创建，不需要组件标记
      const hit = [...sources].find(([, src]) => src.includes(`data-mod-slot="${slot}"`));
      if (!hit) missing.push(slot);
    }
    assert.deepEqual(missing, [], `这些挂在枚举里、但没有组件渲染它们：${missing.join(', ')}`);
    // 可重复宿主还必须带 `data-mod-slot-key`（面板靠它知道自己是哪一张卡）
    for (const slot of MOD_PANEL_REPEATABLE) {
      const hit = [...sources].find(([, src]) => src.includes(`data-mod-slot="${slot}"`) && src.includes('data-mod-slot-key='));
      assert.ok(hit, `可重复宿主 ${slot} 的容器必须带 data-mod-slot-key`);
    }
  });
});
