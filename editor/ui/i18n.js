// editor/ui/i18n.js — 编辑器界面的中英双语层（无构建步骤、无依赖）。
//
// 设计取舍：**以中文原文作为词典的键**（词典在 i18n.en.js）。
//   * 中文界面因此不需要维护任何对照表：查不到就原样返回中文；
//   * 英文词典只写「中文 → 英文」，加一条翻译就是加一行，不必给几百条文案起英文 key 名；
//   * 缺译文时退回中文——宁可看到中文，也不要看到 `pack.newOperator` 这种 key 名，更不要变成空白。
//   这条「缺译文退回中文」是刻意的，test/editorI18n.test.js 里有测试钉住它。
//
// 用法：
//   import { t, mountI18n } from './i18n.js';
//   h('button', {}, t('保存并生成'))                                  // JS 里的文案
//   <a href="./enemy.html" data-i18n="怪物编辑器">怪物编辑器</a>          // HTML 里的静态文案
//   t('已保存 {0}，生成 {1}。', slug, files)                            // 带参数：{0} {1} 依次替换
//   mountI18n(renderShell)                                            // 页尾挂一次：静态文案 + 右上角切换 + 换语言后重画

import { EN } from './i18n.en.js';

/** 支持的语言。zh 是原文，也是兜底。 */
export const LANGS = Object.freeze(['zh', 'en']);
/** 语言记忆在 localStorage 的这个键里（关掉浏览器再打开还是上次选的）。 */
export const LANG_STORAGE_KEY = 'sp-editor-lang';

/** 只认 'zh' 与 'en'：'en-US' → 'en'，'fr' → 'zh'（原文）。 */
export function normalizeLang(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v.startsWith('en')) return 'en';
  return 'zh';
}

/** 把 `{0}` `{1}` 换成参数；参数里的 `$&` 之类不会被当成替换模式。 */
function fill(text, args) {
  return String(text).replace(/\{(\d+)\}/g, (whole, i) => {
    const v = args[Number(i)];
    return v === undefined || v === null ? whole : String(v);
  });
}

let lang = null;
const listeners = new Set();

/** 当前语言。优先级：显式 setLang > URL 的 ?lang= > localStorage > 中文。 */
export function currentLang() {
  if (lang) return lang;
  lang = normalizeLang(readUrlLang() ?? readStoredLang());
  return lang;
}

function readUrlLang() {
  try {
    const q = globalThis.location?.search;
    return q ? new URLSearchParams(q).get('lang') : null;
  } catch { return null; }
}

function readStoredLang() {
  try { return globalThis.localStorage?.getItem(LANG_STORAGE_KEY) ?? null; } catch { return null; }
}

/**
 * 翻译：`t('保存并生成')`，或带参数 `t('已保存 {0}', slug)`。
 * @param {string} zh 中文原文（词典的键）
 * @param {...any} args `{0}` `{1}` 位置的参数
 * @returns {string}
 */
export function t(zh, ...args) {
  const table = { en: EN }[currentLang()];
  const hit = table && Object.prototype.hasOwnProperty.call(table, zh) ? table[zh] : null;
  const text = typeof hit === 'string' && hit ? hit : String(zh);
  return args.length ? fill(text, args) : text;
}

/** 换语言：写 localStorage、通知所有监听者，并返回生效后的语言。 */
export function setLang(next) {
  const v = normalizeLang(next);
  lang = v;
  try { globalThis.localStorage?.setItem(LANG_STORAGE_KEY, v); } catch { /* 隐私模式下写不了，忽略 */ }
  for (const fn of [...listeners]) { try { fn(v); } catch { /* 一个监听者出错不该拖垮其它 */ } }
  return v;
}

/** 注册「语言变了」的回调（动态渲染的页面靠它重画）。返回取消注册的函数。 */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 把 HTML 里的静态文案换掉。识别三种标记：
 *   `data-i18n`（文本）、`data-i18n-title`（title 属性）、`data-i18n-placeholder`（placeholder 属性）。
 * 元素里原本写的中文就是兜底：就算脚本没跑起来，页面也是中文而不是空白。
 * @param {ParentNode} [root] 默认整篇文档；测试里可以传一个桩对象
 * @returns {number} 替换了几处
 */
export function applyI18n(root = globalThis.document) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let n = 0;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute?.('data-i18n');
    if (key) { el.textContent = t(key); n++; }
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute?.('data-i18n-title');
    if (key) { el.setAttribute('title', t(key)); n++; }
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute?.('data-i18n-placeholder');
    if (key) { el.setAttribute('placeholder', t(key)); n++; }
  }
  return n;
}

/** 右上角的语言切换按钮：中文界面显示 `EN`，英文界面显示 `中文`。 */
export function langSwitch() {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.id = 'btnLang';
  btn.className = 'ghost';
  btn.style.width = 'auto';
  btn.addEventListener('click', () => setLang(currentLang() === 'zh' ? 'en' : 'zh'));
  paintLangSwitch(btn);
  onLangChange(() => paintLangSwitch(btn));
  return btn;
}

function paintLangSwitch(btn) {
  const zh = currentLang() === 'zh';
  btn.textContent = zh ? 'EN' : '中文';
  btn.title = zh ? 'Switch the editor UI to English' : '把编辑器界面切回中文';
}

/**
 * 页面挂载：换掉静态文案、把语言切换按钮塞进 `header .row`、换语言后重画。
 * @param {() => void} [rerender] 动态页面的重画函数（JS 里生成的文案也要跟着换）
 * @returns {() => void} 强制重画一次的函数
 */
export function mountI18n(rerender) {
  const doc = globalThis.document;
  if (!doc) return () => {};
  // 标题在 <title> 里写死，先记住原文（英文界面下 document.title 已经是译名，不能再当 key）
  const titleKey = doc.title;
  const paint = () => {
    doc.documentElement?.setAttribute('lang', currentLang() === 'en' ? 'en' : 'zh-CN');
    if (titleKey) doc.title = t(titleKey);
    applyI18n(doc);
    if (typeof rerender === 'function') rerender();
  };
  if (!doc.getElementById('btnLang')) {
    const host = doc.querySelector('header .row') || doc.querySelector('header');
    if (host) host.append(langSwitch());
  }
  onLangChange(paint);
  paint();
  return paint;
}
