// test/editorI18n.test.js — 编辑器界面的中英双语层（editor/ui/i18n.js + editor/ui/i18n.en.*.js）。
//
// 这一层能长大的前提是「漏翻译会被机器抓住」，所以这里查的不只是 API 行为，还有**源码与词典的一致性**：
//
//   1. 前向：源码里 `t('中文')`、`data-i18n="中文"`、`data-i18n-title`、`data-i18n-placeholder`、`<title>` 用到的
//      每一条中文，英文词典里都必须有 —— 少一条就失败（页面上那条会悄悄留在中文）。
//   2. 反向：英文词典里每一条带中文的键，源码里都必须真的用到 —— 页面改文案后遗留的死键就是靠这条清掉的。
//   3. 卫生：值不能是空的、值里不能留中文、分片之间不能有重复键（同一条中文译两遍，必然有一天只改了一处）。
//
// 键就是中文原文，因此「缺译文退回中文」是设计的一部分而不是缺陷：宁可看到中文，也不要看到 `pack.newOperator`
// 这种 key 名或一片空白。下面有测试专门钉住这条退路。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = join(ROOT, 'editor', 'ui');

// 先装一个假的 localStorage：setLang 的行为里有「记住选择」这一半，测它需要有个能记账的地方。
// （真浏览器里是同一个接口，隐私模式下写不进去时 i18n.js 会吞掉异常，所以这里也不强求。）
const store = new Map();
try {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
} catch { /* 环境不给就算了，下面的断言会自动跳过那一半 */ }

const i18n = await import('../editor/ui/i18n.js');
const { EN, EN_CHUNKS } = await import('../editor/ui/i18n.en.js');
const { t, setLang, currentLang, normalizeLang, applyI18n, onLangChange, mountI18n, LANGS, LANG_STORAGE_KEY } = i18n;

/** 中日韩统一表意文字、CJK 标点与全角形式：英文值里出现这些就说明漏翻了。 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 允许在英文界面里保留中文的条目（目前为空：需要时在这里写明理由，不要图省事）。 */
const KEEP_ZH = new Set([]);

// ---- 收集源码里用到的键 ------------------------------------------------------------------------------------------

/** 去掉注释再扫，免得把注释里的示例 t('…') 当成真文案。
 *
 *  必须**先认出字符串**：字符串里的 `/*` 不是注释开头。踩过的坑：`'…/assets/**（…'` 这种路径会被当成块注释，
 *  一路吞到文件里下一个块注释结束标记（也就是 `*` 紧跟 `/` 这两个字符），中间几十条 t() 全被判成死键——而失败信息
 *  极难看出真正原因。所以这里按字符走一遍，字符串（含模板串）内部一律原样保留。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < n) {
        const ch = src[i];
        out += ch; i++;
        if (ch === '\\') { out += src[i] ?? ''; i++; continue; }
        if (ch === c) break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 一个源码文件里所有「翻译入口」用到的中文键。 */
function keysOf(file, src) {
  const found = new Set();
  const text = file.endsWith('.js') ? stripComments(src) : src;
  if (file.endsWith('.js')) {
    // t('…') / t("…")：前面不能是标识符字符，否则 split('x') 会被误认为 t('x')
    for (const re of [/(?<![A-Za-z0-9_$.])t\('((?:[^'\\\n]|\\.)*)'/g, /(?<![A-Za-z0-9_$.])t\("((?:[^"\\\n]|\\.)*)"/g]) {
      for (const m of text.matchAll(re)) found.add(m[1]);
    }
  } else {
    for (const m of text.matchAll(/<title>([^<]*)<\/title>/g)) found.add(m[1]);
    for (const m of text.matchAll(/data-i18n="([^"]*)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/data-i18n-title="([^"]*)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/data-i18n-placeholder="([^"]*)"/g)) found.add(m[1]);
  }
  return found;
}

const UI_FILES = readdirSync(UI_DIR).filter((f) => /\.(js|html)$/.test(f) && !f.startsWith('i18n'));
const SOURCE_KEYS = new Map(); // 键 -> 用到它的文件列表
for (const file of UI_FILES) {
  for (const key of keysOf(file, readFileSync(join(UI_DIR, file), 'utf8'))) {
    if (!SOURCE_KEYS.has(key)) SOURCE_KEYS.set(key, []);
    SOURCE_KEYS.get(key).push(file);
  }
}
const CJK_SOURCE_KEYS = [...SOURCE_KEYS.keys()].filter((k) => CJK.test(k));

// ---- 语言选择 ---------------------------------------------------------------------------------------------------

describe('编辑器双语：语言选择', () => {
  test('normalizeLang 只认 zh 与 en，其余一律回中文', () => {
    assert.deepEqual(LANGS, ['zh', 'en']);
    assert.equal(normalizeLang('en'), 'en');
    assert.equal(normalizeLang('EN-US'), 'en');
    assert.equal(normalizeLang(' en '), 'en');
    assert.equal(normalizeLang('zh'), 'zh');
    assert.equal(normalizeLang('zh-CN'), 'zh');
    assert.equal(normalizeLang('fr'), 'zh');
    assert.equal(normalizeLang(undefined), 'zh');
    assert.equal(normalizeLang(null), 'zh');
  });

  test('setLang 切语言、通知监听者、记住选择', () => {
    const seen = [];
    const off = onLangChange((v) => seen.push(v));
    assert.equal(setLang('en'), 'en');
    assert.equal(currentLang(), 'en');
    assert.deepEqual(seen, ['en']);
    // 取消注册之后不再收到
    off();
    setLang('zh');
    assert.deepEqual(seen, ['en']);
    assert.equal(currentLang(), 'zh');
    if (globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function') {
      assert.equal(globalThis.localStorage.getItem(LANG_STORAGE_KEY), 'zh');
    }
  });

  test('setLang 传别的语言按中文处理', () => {
    setLang('jp');
    assert.equal(currentLang(), 'zh');
  });
});

// ---- 查表 -------------------------------------------------------------------------------------------------------

describe('编辑器双语：查表', () => {
  test('中文界面原样返回，英文界面查得到译文', () => {
    setLang('zh');
    assert.equal(t('保存并生成'), '保存并生成');
    setLang('en');
    assert.equal(t('保存并生成'), 'Save and generate');
    setLang('zh');
  });

  test('缺译文时退回中文原文，而不是 key 名或空白', () => {
    const missing = '这句中文肯定不在词典里';
    assert.equal(t(missing), missing);
    setLang('en');
    assert.equal(t(missing), missing, '英文界面下缺译文也必须看得懂');
    setLang('zh');
  });

  test('{0} {1} 按位置替换，缺参数时保留占位符原样', () => {
    setLang('zh');
    assert.equal(t('已保存 {0}，生成 {1}。', 'a', 'b'), '已保存 a，生成 b。');
    assert.equal(t('已保存 {0}，生成 {1}。', 'a'), '已保存 a，生成 {1}。');
    assert.equal(t('{0} 个错误（必须修）', 3), '3 个错误（必须修）');
    setLang('en');
    assert.equal(t('{0} 个错误（必须修）', 3), '3 error(s) — must be fixed');
    setLang('zh');
  });

  test('译文里带 $& 之类的替换模式不会被当成模式解析', () => {
    setLang('zh');
    // 用一条真译文试：替换值里的 $ 必须原样留下（String.replace 的替换串陷阱）
    assert.equal(t('{0} 条警告', '$&$1'), '$&$1 条警告');
    setLang('zh');
  });
});

// ---- 静态 HTML 标记 ---------------------------------------------------------------------------------------------

describe('编辑器双语：静态 HTML 标记', () => {
  const el = (attrs = {}) => ({
    attrs: { ...attrs },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    textContent: '',
  });

  test('三种标记都会替换，返回值是替换处数', () => {
    setLang('en');
    const nodes = {
      '[data-i18n]': [el({ 'data-i18n': '保存并生成' })],
      '[data-i18n-title]': [el({ 'data-i18n-title': '重新载入' })],
      '[data-i18n-placeholder]': [el({ 'data-i18n-placeholder': '如 fastshot / fortress / bard' })],
    };
    const root = { querySelectorAll: (sel) => nodes[sel] || [] };
    assert.equal(applyI18n(root), 3);
    assert.equal(nodes['[data-i18n]'][0].textContent, 'Save and generate');
    assert.equal(nodes['[data-i18n-title]'][0].attrs.title, 'Reload');
    assert.equal(nodes['[data-i18n-placeholder]'][0].attrs.placeholder, 'e.g. fastshot / fortress / bard');
    setLang('zh');
  });

  test('没有 DOM 时不炸，返回 0', () => {
    assert.equal(applyI18n(null), 0);
    assert.equal(applyI18n({}), 0);
  });
});

// ---- 页面挂载 ---------------------------------------------------------------------------------------------------

describe('编辑器双语：页面挂载', () => {
  /** 够 mountI18n 用的极小 DOM 桩：header > .row，其余按需生成。 */
  function stubDoc() {
    const make = (tag) => ({
      tagName: tag,
      id: '',
      attrs: {},
      style: {},
      children: [],
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] ?? null; },
      append(c) { this.children.push(c); },
      addEventListener() {},
      querySelectorAll: () => [],
    });
    const header = make('header');
    const row = make('div');
    header.children.push(row);
    const doc = {
      title: '卫戍协议 · 创意工坊编辑器',
      documentElement: make('html'),
      createElement: (tag) => make(tag),
      querySelector: (sel) => (sel === 'header .row' ? row : sel === 'header' ? header : null),
      querySelectorAll: () => [],
      getElementById: (id) => row.children.find((c) => c.id === id) || null,
    };
    return { doc, row };
  }

  test('挂载会插入唯一一个语言按钮，重复挂载不会插第二个', () => {
    const { doc, row } = stubDoc();
    const saved = globalThis.document;
    globalThis.document = doc;
    try {
      mountI18n();
      const first = row.children.filter((c) => c.id === 'btnLang');
      assert.equal(first.length, 1, '应该插入一个语言切换按钮');
      assert.equal(first[0].tagName, 'button');
      mountI18n();
      assert.equal(row.children.filter((c) => c.id === 'btnLang').length, 1, '重复挂载不能又插一个');
      assert.equal(doc.title, t('卫戍协议 · 创意工坊编辑器'), '页面标题也要跟着语言走');
    } finally {
      globalThis.document = saved;
    }
  });

  test('按钮文字与语言相反：中文界面显示 EN，英文界面显示中文', () => {
    const { doc, row } = stubDoc();
    const saved = globalThis.document;
    globalThis.document = doc;
    try {
      setLang('zh');
      mountI18n();
      assert.equal(row.children.find((c) => c.id === 'btnLang').textContent, 'EN');
      setLang('en');
      assert.equal(row.children.find((c) => c.id === 'btnLang').textContent, '中文');
    } finally {
      setLang('zh');
      globalThis.document = saved;
    }
  });
});

// ---- 词典卫生 ---------------------------------------------------------------------------------------------------

describe('编辑器双语：词典卫生', () => {
  test('每条译文都是非空字符串', () => {
    for (const [key, value] of Object.entries(EN)) {
      assert.equal(typeof value, 'string', `『${key}』的译文不是字符串`);
      assert.ok(value.trim(), `『${key}』的译文是空的`);
      assert.equal(value, value.trim(), `『${key}』的译文首尾有空白`);
    }
  });

  test('译文里不留中文（要留的必须写进 KEEP_ZH 并说明理由）', () => {
    const bad = Object.entries(EN).filter(([key, value]) => CJK.test(value) && !KEEP_ZH.has(key));
    assert.deepEqual(bad.map(([k, v]) => `${k} -> ${v}`), [], '英文词典里出现了中文，要么翻掉，要么进 KEEP_ZH');
  });

  test('分片之间没有重复键（同一条中文只准译一次）', () => {
    const seen = new Map();
    const dups = [];
    for (const [chunk, table] of Object.entries(EN_CHUNKS)) {
      for (const key of Object.keys(table)) {
        if (seen.has(key)) dups.push(`『${key}』同时出现在 ${seen.get(key)} 与 ${chunk}`);
        else seen.set(key, chunk);
      }
    }
    assert.deepEqual(dups, []);
  });

  test('词典的键都是非空字符串', () => {
    for (const key of Object.keys(EN)) assert.ok(typeof key === 'string' && key.trim(), '词典里有空键');
  });
});

// ---- 源码与词典的一致性（漏翻译的闸门） ---------------------------------------------------------------------------

describe('编辑器双语：源码与词典一致', () => {
  test('源码里用到的每条中文都译过（漏一条就失败，并指出是哪个文件）', () => {
    const missing = CJK_SOURCE_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
    assert.deepEqual(
      missing.map((k) => `${k}  ←  ${SOURCE_KEYS.get(k).join(', ')}`),
      [],
      '这些界面文案还没有英文译文',
    );
  });

  test('词典里每条带中文的键都还在源码里用着（没有死键）', () => {
    const dead = Object.keys(EN).filter((k) => CJK.test(k) && !SOURCE_KEYS.has(k));
    assert.deepEqual(dead, [], '这些译文对应的中文已经不在界面上了，删掉它们');
  });

  test('每页都有词条分片，且分片文件本身不被当成页面源码扫描', () => {
    for (const page of ['shared', 'index', 'stage', 'enemy', 'wave', 'item', 'kit', 'voice', 'pack', 'bond']) {
      assert.ok(EN_CHUNKS[page], `缺少 ${page} 分片`);
    }
    assert.ok(UI_FILES.every((f) => !f.startsWith('i18n')), 'i18n*.js 不该被当成页面源码');
    assert.ok(UI_FILES.includes('app.js') && UI_FILES.includes('index.html'), '扫描列表得真的包含页面文件');
  });

  test('没有把带插值的模板串直接塞进 t()（那样查不到词典）', () => {
    const bad = [];
    for (const file of UI_FILES.filter((f) => f.endsWith('.js'))) {
      const text = stripComments(readFileSync(join(UI_DIR, file), 'utf8'));
      for (const m of text.matchAll(/(?<![A-Za-z0-9_$.])t\(`([^`]*)`/g)) {
        if (m[1].includes('${')) bad.push(`${file}: t(\`${m[1]}\`)`);
      }
    }
    assert.deepEqual(bad, [], '带插值的文案要写成 t(\'…{0}…\', 值)');
  });
});
