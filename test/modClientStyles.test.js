// test/modClientStyles.test.js — C 层的**两条样式路**（业主裁决 2026-10-10：「两条路一起给」）。
//
//   ① 主题变量 `client.theme.vars`：写 CSS 自定义属性，**加法**语义，`dispose` 时按名字恢复原值；
//   ② 面板自带样式表 `client.panels[].styles[]`：包内的 `.css`，走 `/workshop-panels/` 那条**只服务登记过的 URL**
//      的通道，`<link>` 追加到 `<head>` 末尾（排在引擎样式之后），`dispose` 时移除。
//
// 这一条裁决放宽了 `docs/design/mod-layer.md` 原来那句「包带 CSS 是方向性错误」—— 理由与边界都写在
// `docs/WORKSHOP.md` §1.9.5：变量装不下「一整份新组件的样式」，而插件包那三份（chat 21 KB / devices 11.7 KB /
// title 22 KB）正是后者。安全边界一个字没放松：**只服务登记过的 URL**，客户端是第二个读者，坏声明点名拒绝。
//
// 断言分四组：声明层（形状 + 点名拒绝）· 装载期（声明了却读不到 ⇒ 整包被拒）· 服务面与 `welcome`（真 HTTP）·
// 客户端注册表（注入顺序、可撤销、没有宿主就点名）。
//
// Run: node --test test/modClientStyles.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, WORKSHOP_PANEL_PREFIX } from '../shared/workshop.js';
import { loadWorkshop, loadWorkshopPanels, workshopThemeFor } from '../server/workshop.js';
import { workshopPanelFilesFor } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';
import { createPanelRegistry, THEME_VAR_RE, MOD_PANEL_PREFIX as MOD_PREFIX } from '../public/js/ui/extensions.js';
import { TestClient } from './helpers/wsClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const base = (extra = {}) => ({
  id: 'style-pack', name: 'Style Pack', version: '1.0.0', license: 'CC0-1.0', description: 'x',
  gameVersion: '0.2.x', ...extra,
});
const PANEL = (extra = {}) => ({ id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', ...extra });
const accepts = (raw, note) => {
  const v = normalizePackManifest(raw, raw.id, { hasAssets: false });
  assert.equal(v.ok, true, `${note}: 应当被接受，实际 ${v.ok ? '' : `${v.error} — ${v.detail}`}`);
  return v.pack;
};
const refuses = (raw, code, note) => {
  const v = normalizePackManifest(raw, raw.id, { hasAssets: false });
  assert.equal(v.ok, false, `${note}: 应当被拒，实际被接受`);
  assert.equal(v.error, code, `${note}: 期待 ${code}，实际 ${v.error} — ${v.detail}`);
};

// ---------------------------------------------------------------------------------------------------------------
describe('声明层：面板自带样式表与主题变量', () => {
  test('styles 被接受并归一化成**稳定序**清单（注入顺序就是层叠顺序）', () => {
    const pack = accepts(base({ client: { panels: [PANEL({ styles: ['ui/b.css', 'ui/a.css'] })] } }), 'styles');
    assert.deepEqual(pack.client.panels[0].styles, ['ui/a.css', 'ui/b.css']);
  });

  test('每一种写错的 styles 都点名拒绝', () => {
    const bad = (styles, code, note) => refuses(base({ client: { panels: [PANEL({ styles })] } }), code, note);
    bad('ui/a.css', 'CLIENT_BAD_PANEL_STYLES', '不是数组');
    bad([], 'CLIENT_BAD_PANEL_STYLES', '空数组');
    bad(['ui/a.scss'], 'CLIENT_BAD_PANEL_STYLE', '不是 .css');
    bad(['/ui/a.css'], 'CLIENT_BAD_PANEL_STYLE', '绝对路径');
    bad(['../a.css'], 'CLIENT_BAD_PANEL_STYLE', '爬出包');
    bad(['ui/a.css', 'ui/a.css'], 'CLIENT_DUPLICATE_PANEL_STYLE', '重复');
    bad(Array.from({ length: 9 }, (_, i) => `ui/s${i}.css`), 'CLIENT_BAD_PANEL_STYLES', '超过 8 份');
    bad([7], 'CLIENT_BAD_PANEL_STYLE', '不是字符串');
  });

  test('theme.vars 被接受：名字排序、数字转字符串', () => {
    const pack = accepts(base({
      client: { panels: [PANEL()], theme: { vars: { '--sp-w': 12, '--sp-accent': '#c33' } } },
    }), 'theme');
    assert.deepEqual(pack.client.theme.vars, { '--sp-accent': '#c33', '--sp-w': '12' });
  });

  test('坏主题点名拒绝：名字必须以 `--` 开头，值不许能结束自己的声明', () => {
    const withTheme = (theme) => base({ client: { panels: [PANEL()], theme } });
    refuses(withTheme({ vars: { accent: '#c33' } }), 'CLIENT_THEME_BAD_VAR_NAME', '名字没有 --');
    refuses(withTheme({ vars: { '--x': 'red; background: url(//evil)' } }), 'CLIENT_THEME_BAD_VAR_VALUE', '值里有分号');
    refuses(withTheme({ vars: { '--x': 'a}b' } }), 'CLIENT_THEME_BAD_VAR_VALUE', '值里有花括号');
    refuses(withTheme({ vars: { '--x': '' } }), 'CLIENT_THEME_BAD_VAR_VALUE', '空值');
    refuses(withTheme({ vars: {} }), 'CLIENT_THEME_BAD_VARS', '空 vars');
    refuses(withTheme({ vars: { ['--' + 'a'.repeat(65)]: 'red' } }), 'CLIENT_THEME_BAD_VAR_NAME', '名字太长');
    refuses(withTheme({ vars: { '--x': 'x'.repeat(401) } }), 'CLIENT_THEME_BAD_VAR_VALUE', '值太长');
    refuses(withTheme({ vars: ['--x'] }), 'CLIENT_THEME_BAD_VARS', 'vars 不是对象');
    refuses(withTheme({ colour: {} }), 'CLIENT_THEME_UNKNOWN_FIELD', '未知字段');
    refuses(withTheme(null), 'CLIENT_THEME_BAD_SHAPE', 'theme 不是对象');
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`--v${i}`, 'x']));
    refuses(withTheme({ vars: many }), 'CLIENT_THEME_TOO_MANY_VARS', '超过 200 个变量');
  });

  test('两条路可以同时声明（这就是「两条路一起给」）', () => {
    const pack = accepts(base({
      client: { panels: [PANEL({ styles: ['ui/chat.css'] })], theme: { vars: { '--sp-chat-bg': '#111' } } },
    }), 'both');
    assert.deepEqual(pack.client.panels[0].styles, ['ui/chat.css']);
    assert.deepEqual(pack.client.theme.vars, { '--sp-chat-bg': '#111' });
  });

  test('只想换几个颜色的包**不必附一个空面板**：只有 theme 也能过（业主裁决的简便性那一半）', () => {
    const pack = accepts(base({ client: { theme: { vars: { '--sp-bg': '#000' } } } }), 'theme only');
    assert.deepEqual(pack.client.panels, []);
    assert.deepEqual(pack.client.theme.vars, { '--sp-bg': '#000' });
    // 但 `client` 什么都不能声明的两种写法照旧被拒（能力声明单独存在 = 什么都没声明）
    refuses(base({ client: {} }), 'CLIENT_BAD_PANELS', '空 client');
    refuses(base({ client: { requires: ['webCrypto'] } }), 'CLIENT_BAD_PANELS', '只有 requires');
  });

  test('客户端那份名字判据与服务端逐字相同（两处真相会漂）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shared/workshop.js'), 'utf8');
    const m = /const CLIENT_THEME_VAR_RE = (\/.*\/);/.exec(src);
    assert.ok(m, '形状层里找得到那条判据');
    assert.equal(THEME_VAR_RE.source, m[1].slice(1, m[1].lastIndexOf('/')), '客户端 extensions.js 的 THEME_VAR_RE 必须与形状层一致');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('装载期 + 服务面 + welcome（真目录、真 HTTP）', () => {
  const CSS = '.mod-chat { color: var(--sp-chat-fg, #fff); }\n';
  let tmp;
  let wsRoot;
  before(() => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-modcss-'));
    wsRoot = path.join(tmp, 'ws');
    const dir = path.join(wsRoot, 'style-pack');
    fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'style-pack', name: 'Style Pack', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', combat: true,
      client: {
        panels: [{ id: 'chat', slot: 'root.overlays', module: 'ui/chat.js', styles: ['ui/chat.css'] }],
        theme: { vars: { '--sp-chat-fg': '#ffcc00' } },
      },
    }));
    fs.writeFileSync(path.join(dir, 'ui', 'chat.js'), 'export function mount() { return {}; }\n');
    fs.writeFileSync(path.join(dir, 'ui', 'chat.css'), CSS);
    // 第二个包：声明了一份**不在包里**的样式表 ⇒ 整包被拒（下面那条测试要它）
    const gone = path.join(wsRoot, 'gone-pack');
    fs.mkdirSync(path.join(gone, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(gone, 'pack.json'), JSON.stringify({
      id: 'gone-pack', name: 'Gone', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', combat: true,
      client: { panels: [{ id: 'x', slot: 'root.overlays', module: 'ui/x.js', styles: ['ui/missing.css'] }] },
    }));
    fs.writeFileSync(path.join(gone, 'ui', 'x.js'), 'export function mount() { return {}; }\n');
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  test('声明了一份读不到的样式表 ⇒ **整包被拒**并点名（不是少注入一份）', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    assert.equal(loaded.packs.some((p) => p.id === 'gone-pack'), false, '模块在、样式表不在 ⇒ 整包不出现');
    const err = loaded.errors.find((e) => e.pack === 'gone-pack');
    // `loadWorkshop` 的错误行把码写在理由前面（`<CODE>: <reason>`）—— 与别处同一形状。
    assert.match(err.reason, /CLIENT_BAD_PANEL_STYLE/);
    assert.match(err.reason, /ui\/missing\.css/);
  });

  test('清单里带上样式表的 `path` 与登记 URL（与模块同一份 `?v=`）', () => {
    const { panels, errors } = loadWorkshopPanels(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
    assert.deepEqual(errors, []);
    const panel = panels.find((p) => p.id === 'chat');
    assert.equal(panel.styles.length, 1);
    assert.equal(panel.styles[0].path, 'ui/chat.css');
    assert.equal(panel.styles[0].url, `${WORKSHOP_PANEL_PREFIX}style-pack/ui/chat.css?v=${panel.hash.slice(0, 12)}`);
  });

  test('服务表把两条通道都收进去（`.js` 与 `.css`），逃出包的样式路径不进表', () => {
    const { panels } = loadWorkshopPanels(loadWorkshop(wsRoot, { log: quiet }), { log: quiet });
    const files = workshopPanelFilesFor(panels, wsRoot);
    assert.equal(files.get(`${WORKSHOP_PANEL_PREFIX}style-pack/ui/chat.js`), path.join(wsRoot, 'style-pack', 'ui', 'chat.js'));
    assert.equal(files.get(`${WORKSHOP_PANEL_PREFIX}style-pack/ui/chat.css`), path.join(wsRoot, 'style-pack', 'ui', 'chat.css'));
    assert.equal(workshopPanelFilesFor([{ pack: 'p', styles: [{ path: '../x.css', url: '/workshop-panels/p/../x.css' }] }], wsRoot).size, 0);
    assert.equal(workshopPanelFilesFor([{ pack: 'p', styles: [{ path: 'a.css', url: '/workshop-panels/p/a.scss' }] }], wsRoot).size, 0);
  });

  test('主题合并：包 id 小的持有那个变量，后到的包被点名', () => {
    const theme = (vars) => ({ client: { theme: { vars } } });
    const r = workshopThemeFor({
      packs: [{ id: 'zeta', ...theme({ '--sp-a': '#2', '--sp-z': '#9' }) }, { id: 'alpha', ...theme({ '--sp-a': '#1' }) }],
    }, { log: quiet });
    assert.deepEqual(r.theme, { vars: { '--sp-a': '#1', '--sp-z': '#9' } }, 'alpha 先到，它持有 --sp-a');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].code, 'CLIENT_THEME_VAR_TAKEN');
    assert.equal(r.errors[0].pack, 'zeta');
    assert.match(r.errors[0].reason, /"alpha"/);
    assert.equal(workshopThemeFor({ packs: [] }, { log: quiet }).theme, null, '没有包声明主题 ⇒ null（调用方一个字段都不加）');
  });

  test('样式表的**字节**进内容哈希：换一份样式就是换一个身份', () => {
    const before = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'style-pack');
    assert.ok(before.manifest.some((m) => m.path === 'ui/chat.css'), '样式表源码在身份清单里');
    const cssPath = path.join(wsRoot, 'style-pack', 'ui', 'chat.css');
    const original = fs.readFileSync(cssPath, 'utf8');
    fs.writeFileSync(cssPath, `${original}\n.mod-chat { padding: 4px; }\n`);
    const after = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'style-pack');
    assert.notEqual(after.hash, before.hash, '样式字节变了，内容哈希必须跟着变');
    fs.writeFileSync(cssPath, original);
    assert.equal(loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'style-pack').hash, before.hash);
  });

  test('只有主题变量的包也是一个**能加载**的包，层推导是 C', () => {
    const root = path.join(tmp, 'theme-root');
    const dir = path.join(root, 'theme-only');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'theme-only', name: 'Colors', version: '1.0.0', license: 'CC0-1.0', description: 'x',
      gameVersion: '0.2.2', client: { theme: { vars: { '--sp-accent': '#c33' } } },
    }));
    const loaded = loadWorkshop(root, { log: quiet });
    assert.deepEqual(loaded.errors, [], '只有主题的包不该有任何加载错误');
    const pack = loaded.packs.find((p) => p.id === 'theme-only');
    assert.ok(pack, '它必须被算作一个加载了的包');
    assert.equal(pack.layer, 'C', '改界面的是 C 层');
    assert.equal(loadWorkshopPanels(loaded, { log: quiet }).panels.length, 0, '没有面板就没有面板清单');
    assert.deepEqual(workshopThemeFor(loaded, { log: quiet }).theme, { vars: { '--sp-accent': '#c33' } });
  });

  test('真 HTTP：登记过的 `.css` 以 text/css 送出；未登记的、穿越的一律 404', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    try {
      const listed = srv.lobby.welcomeInfo().modPanels.find((p) => p.id === 'chat');
      const res = await fetch(srv.url + listed.styles[0].url);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/css/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal((await res.text()).trim(), CSS.trim());
      for (const p of [
        '/workshop-panels/style-pack/ui/missing.css',
        '/workshop-panels/style-pack/../ui/chat.css',
        '/workshop-panels/style-pack/pack.json',
      ]) {
        assert.equal((await fetch(srv.url + p)).status, 404, p);
      }
    } finally {
      await srv.close();
    }
  });

  test('welcome：声明了主题才有 `modTheme`；没有的安装一个字段都不多', async () => {
    const withTheme = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    const without = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: path.join(ROOT, 'docs/examples') });
    const clients = [];
    try {
      const c1 = await TestClient.connect(`${withTheme.url.replace('http', 'ws')}/ws`);
      clients.push(c1);
      const w1 = await c1.hello('样式博士');
      assert.deepEqual(w1.modTheme, { vars: { '--sp-chat-fg': '#ffcc00' } });
      assert.equal(w1.modPanels[0].styles[0].path, 'ui/chat.css');

      const c2 = await TestClient.connect(`${without.url.replace('http', 'ws')}/ws`);
      clients.push(c2);
      const w2 = await c2.hello('干净博士');
      assert.equal('modTheme' in w2, false, '没有包声明主题 ⇒ welcome 里没有这个字段');
    } finally {
      for (const c of clients) { try { await c.close(); } catch { /* already closed */ } }
      await withTheme.close();
      await without.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('客户端注册表：注入样式表、写主题变量、都能收回来', () => {
  /** 极小的假 DOM：只够 extensions.js 用到的那几个方法。 */
  const el = (tag) => ({
    tag, children: [], attrs: {}, className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
    remove() { this.removed = true; },
  });
  const fakeStore = () => ({ get: () => ({}), subscribe: () => () => {}, patch: () => {} });
  const fakeHead = () => el('head');
  const fakeRoot = () => {
    /** @type {Record<string, string>} */
    const vars = {};
    return {
      vars,
      style: {
        getPropertyValue: (n) => vars[n] ?? '',
        setProperty: (n, v) => { vars[n] = v; },
        removeProperty: (n) => { delete vars[n]; },
      },
    };
  };
  const registry = (deps = {}) => createPanelRegistry({
    store: fakeStore(),
    importModule: async () => ({ mount: () => ({}) }),
    slotHost: () => el('div'),
    createElement: el,
    ...deps,
  });
  const PANEL_DECL = { id: 'chat', pack: 'style-pack', slot: 'root.overlays', url: `${MOD_PREFIX}style-pack/ui/chat.js`, styles: [{ path: 'ui/chat.css', url: `${MOD_PREFIX}style-pack/ui/chat.css` }] };

  test('挂载前把样式表注入 <head>（后到 = 排在引擎样式之后），dispose 时移除', async () => {
    const head = fakeHead();
    const reg = registry({ styleHost: () => head });
    reg.apply([PANEL_DECL]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(reg.mounted(), ['style-pack/chat']);
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].tag, 'link');
    assert.equal(head.children[0].rel, 'stylesheet');
    assert.equal(head.children[0].href, `${MOD_PREFIX}style-pack/ui/chat.css`);
    assert.deepEqual(reg.styleUrls(), [`${MOD_PREFIX}style-pack/ui/chat.css`]);
    reg.dispose();
    assert.equal(head.children[0].removed, true, '注入过的东西必须能收回来');
    assert.deepEqual(reg.styleUrls(), []);
  });

  test('声明的样式 URL 不在这条通道上 ⇒ 客户端也点名拒绝（第二个读者）', async () => {
    const reg = registry({ styleHost: () => fakeHead() });
    reg.apply([{ ...PANEL_DECL, styles: [{ path: 'ui/x.css', url: 'https://evil.example/x.css' }] }]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(reg.mounted(), []);
    assert.equal(reg.refusals()[0].code, 'CLIENT_BAD_PANEL_STYLE');
  });

  test('没有可注入的宿主 ⇒ 点名拒绝这个面板，不许「挂了但没样式」', async () => {
    const reg = registry({ styleHost: () => null });
    reg.apply([PANEL_DECL]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(reg.mounted(), []);
    assert.equal(reg.refusals()[0].code, 'CLIENT_PANEL_NO_STYLE_HOST');
  });

  test('主题变量：写上去、记下原值、dispose 恢复（没有的原样删掉）', () => {
    const root = fakeRoot();
    root.vars['--sp-accent'] = '#000';
    const reg = registry({ themeHost: () => root });
    assert.deepEqual(reg.applyTheme({ vars: { '--sp-accent': '#c33', '--sp-new': '4px' } }), { applied: 2 });
    assert.equal(root.vars['--sp-accent'], '#c33');
    assert.equal(root.vars['--sp-new'], '4px');
    assert.deepEqual(reg.applyTheme({ vars: { 'accent': '#f00', '--ok': '1px' } }), { applied: 1 }, '坏名字跳过，不写进去');
    assert.equal(root.vars.accent, undefined);
    reg.dispose();
    assert.equal(root.vars['--sp-accent'], '#000', '恢复原值');
    assert.equal('--sp-new' in root.vars, false, '原本没有这个变量 ⇒ 删掉');
    assert.equal(root.vars['--ok'], undefined, 'dispose 之后写过的也收回');
  });

  test('没有主题 / 没有宿主时一次都不写（干净安装一个字段都不多）', () => {
    const root = fakeRoot();
    const reg = registry({ themeHost: () => root });
    assert.deepEqual(reg.applyTheme(null), { applied: 0 });
    assert.deepEqual(reg.applyTheme({}), { applied: 0 });
    assert.deepEqual(Object.keys(root.vars), []);
    const noHost = registry({ themeHost: () => null });
    assert.deepEqual(noHost.applyTheme({ vars: { '--x': '1' } }), { applied: 0 });
  });
});
