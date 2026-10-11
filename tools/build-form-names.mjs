// tools/build-form-names.mjs — 从 `public/js/render/units.js` 的 `FORMS` 生成 `shared/formNames.js`。
//
// `FORMS` 是冻结的第一方常量，**不改**（docs/design/mod-layer.md §28.29 的裁决 1）。加载器与校验器需要的是
// 「第一方在这个 spine id 上已经有哪几个形态名」，那份镜像就是本脚本的产物；守卫在 `test/packForms.test.js`。
//
// 用法：node tools/build-form-names.mjs            （写文件）
//       node tools/build-form-names.mjs --check    （只比对，不写；不一致退出 1）
//
// 与 `npm run forms:names` 同一条命令。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shared', 'formNames.js');

/**
 * 读 `FORMS` 真身并抽成「spine id → 排序后的形态名」。
 *
 * `units.js` 是**浏览器模块**（它 import 别的渲染文件、在模块顶层读 PIXI 相关的东西吗？不 —— 但它的 `FORMS`
 * 初值只用到本文件内的几个 helper），所以在 Node 里 import 它是可行的：`test/render/*.test.js` 就是这么做的
 * （`await import('../../public/js/render/units.js')`）。这里走同一条路，不解析源码文本。
 * @returns {Promise<Record<string, string[]>>}
 */
async function readForms() {
  const { FORMS } = await import(new URL('../public/js/render/units.js', import.meta.url).href);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [spineId, forms] of Object.entries(FORMS)) {
    out[spineId] = Object.keys(forms).sort();
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 渲染 `shared/formNames.js` 的正文。 */
function render(table) {
  const header = readFileSync(OUT, 'utf8').split('\n');
  const start = header.findIndex((l) => l.includes('export const FIRST_PARTY_FORM_NAMES'));
  const prelude = header.slice(0, start).join('\n');
  const keys = Object.keys(table);
  const width = Math.max(...keys.map((k) => k.length));
  const rows = keys.map((k) => `  ${`${k}:`.padEnd(width + 1)} Object.freeze([${table[k].map((n) => `'${n}'`).join(', ')}]),`).join('\n');
  return `${prelude}
export const FIRST_PARTY_FORM_NAMES = Object.freeze({
${rows}
});

/**
 * 一个 spine id 上第一方形态名的集合（\`FIRST_PARTY_FORM_NAMES\` 的查询面）。
 * @param {string} spineId
 * @returns {ReadonlySet<string>} 没有第一方形态时是空集，不是 \`undefined\`（调用点不必再写守卫）
 */
export function firstPartyFormNames(spineId) {
  const list = FIRST_PARTY_FORM_NAMES[spineId];
  return new Set(Array.isArray(list) ? list : []);
}
`;
}

const table = await readForms();
const next = render(table);
const check = process.argv.includes('--check');
if (check) {
  const cur = readFileSync(OUT, 'utf8');
  if (cur !== next) {
    console.error('[form-names] shared/formNames.js 与 public/js/render/units.js 的 FORMS 不一致');
    console.error('  public/js/render/units.js 是那份真相；跑 `node tools/build-form-names.mjs` 重新生成');
    process.exit(1);
  }
  console.log(`[form-names] ok — ${Object.keys(table).length} spine ids`);
} else {
  writeFileSync(OUT, next, 'utf8');
  console.log(`[form-names] 写入 shared/formNames.js — ${Object.keys(table).length} spine ids`);
}
