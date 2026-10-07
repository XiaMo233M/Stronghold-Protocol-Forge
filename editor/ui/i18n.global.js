// editor/ui/i18n.global.js — 给「不许出现 import 的页面」用的入口。
//
// test/kitEditor.test.js 断言 kit.js 里不得出现任何 `import`（含动态 import）。那条断言是有意的安全属性：
// kit 页直接编辑并展示作者写的 kit 源码，页面本身不引入任何东西。所以 kit.html 先加载这个普通模块脚本，
// 由它把 i18n 的接口挂到 globalThis 上，kit.js 再用 `globalThis.spI18n` 取用——零 import，那条断言照旧成立。
//
// 名字仍叫 spI18n，但它现在也带一个共享控件：kit 页的「保存到哪个工坊包」下拉要用和其它页同一个 packSelect
// （editor/ui/packPicker.js），而 kit.js 不许 import，所以由这个桥接模块替它 import 一次。这里只多这一个控件：
// 每多一个，kit 页就多一份「页面自己不许加载的东西」的例外，值得多问一句再放进来。

import { t, applyI18n, mountI18n, setLang, currentLang, onLangChange } from './i18n.js';
import { packSelect } from './packPicker.js';

globalThis.spI18n = Object.freeze({ t, applyI18n, mountI18n, setLang, currentLang, onLangChange, packSelect });

export { t, applyI18n, mountI18n, setLang, currentLang, onLangChange, packSelect };
