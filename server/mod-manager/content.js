// server/mod-manager/content.js — 官方档的**声明式内容合并**（DESIGN 重构计划 Phase 3）。
//
// Forge 档的内容合并住在 `shared/workshop.js`（它的规则是「叠加 + `overrides` 字段级覆盖」）。官方档的规则
// 刻意**更小、更硬**：没有静默覆盖 ——
//
//   * 两张表都是对象（按 id 键）：并集。**同一个 id 由第二个来源再给一次 ⇒ 冲突**，先到者胜，后来者被点名记下；
//   * 两张表都是数组：追加；元素带字符串 `id` 时按 id 去重（同 id ⇒ 冲突并跳过）；
//   * 形状不认识（标量 / 一边对象一边数组 / 嵌套以外的怪东西）：**冲突**，不猜；
//   * 输入**永不被就地改写**（返回全新的表）。
//
// 「先到者胜 + 具名冲突」这条方向与仓库其它地方一致（`pack.json` 未知键点名拒、`mod-registry` 坏条目点名丢）：
// 一个包想改别人的记录，必须明说（`overrides`），而不是靠装载顺序悄悄赢。

import fs from 'node:fs';
import path from 'node:path';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const itemId = (x) => (isObj(x) && typeof x.id === 'string' && x.id ? x.id : null);

/**
 * 把若干来源的声明式内容合并到一份基础表之上。
 *
 * @param {Record<string, any>} base 基础表（**不被修改**）
 * @param {Array<{ packId: string, table: string, data: any }>} contributions
 * @param {{ overrides?: Set<string> }} [opts] `overrides` 里的 `"<table>:<id>"` 允许被**后来的来源**替换
 * @returns {{ tables: Record<string, any>, applied: Array<{packId:string,table:string,keys:string[]}>, conflicts: Array<{packId:string,table:string,key:string,code:string,reason:string}> }}
 */
export function mergeDeclarativeContent(base, contributions, { overrides = new Set() } = {}) {
  const tables = {};
  for (const [k, v] of Object.entries(isObj(base) ? base : {})) {
    tables[k] = Array.isArray(v) ? v.slice() : (isObj(v) ? { ...v } : v);
  }
  const applied = [];
  const seen = new Map(); // table → { kind, ids:Set<string> }
  for (const [k, v] of Object.entries(tables)) {
    if (isObj(v)) seen.set(k, { kind: 'object', ids: new Set(Object.keys(v)) });
    else if (Array.isArray(v)) seen.set(k, { kind: 'array', ids: new Set(v.map(itemId).filter(Boolean)) });
    else seen.set(k, { kind: 'scalar', ids: new Set() });
  }

  const conflicts = [];
  const push = (c) => conflicts.push(c);

  for (const c of Array.isArray(contributions) ? contributions : []) {
    const packId = c?.packId ?? '?';
    const table = c?.table ?? '?';
    const data = c?.data;
    const state = seen.get(table);
    const overwriteAllowed = overrides.has(`${table}:*`);

    if (!state) {
      if (Array.isArray(data)) { tables[table] = data.slice(); seen.set(table, { kind: 'array', ids: new Set(data.map(itemId).filter(Boolean)) }); }
      else if (isObj(data)) { tables[table] = { ...data }; seen.set(table, { kind: 'object', ids: new Set(Object.keys(data)) }); }
      else { push({ packId, table, key: '', code: 'CONTENT_UNSUPPORTED_SHAPE', reason: `"${table}" is neither an object nor an array — a declarative contribution must be one of those` }); continue; }
      applied.push({ packId, table, keys: Array.isArray(data) ? data.map((x) => itemId(x) ?? '?') : Object.keys(data) });
      continue;
    }

    if (state.kind === 'object' && isObj(data)) {
      const keys = [];
      for (const [key, value] of Object.entries(data)) {
        if (state.ids.has(key) && !overwriteAllowed) {
          push({ packId, table, key, code: 'CONTENT_DUPLICATE_ID', reason: `"${table}:${key}" was already contributed by an earlier source; the earlier one wins (declare an override to replace it)` });
          continue;
        }
        tables[table][key] = value;
        state.ids.add(key);
        keys.push(key);
      }
      applied.push({ packId, table, keys });
      continue;
    }

    if (state.kind === 'array' && Array.isArray(data)) {
      const keys = [];
      for (const item of data) {
        const id = itemId(item);
        if (id && state.ids.has(id)) {
          push({ packId, table, key: id, code: 'CONTENT_DUPLICATE_ID', reason: `"${table}:${id}" was already contributed by an earlier source; the earlier one wins` });
          continue;
        }
        tables[table].push(item);
        if (id) state.ids.add(id);
        keys.push(id ?? '?');
      }
      applied.push({ packId, table, keys });
      continue;
    }

    push({ packId, table, key: '', code: 'CONTENT_SHAPE_MISMATCH', reason: `"${table}" is a ${state.kind} but this source contributes a ${Array.isArray(data) ? 'array' : isObj(data) ? 'object' : typeof data}` });
  }

  return { tables, applied, conflicts };
}

/**
 * 从官方插件里收集声明式内容（`descriptor.content` 里的表名 → `<插件目录>/<表名>.json`）。
 *
 * 读不到 / 不是 JSON ⇒ **不静默**：记在 `errors` 里并且**不贡献**（与 `loadOfficialPlugins` 同一条纪律）。
 * @param {Array<any>} plugins `loadOfficialPlugins(...)` 的产物
 * @param {{ readFile?: (abs: string) => string }} [opts]
 */
export function collectOfficialContent(plugins, { readFile = null } = {}) {
  const read = readFile || ((abs) => fs.readFileSync(abs, 'utf8'));
  const contributions = [];
  const errors = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    for (const rel of plugin?.descriptor?.content || []) {
      // 官方 0.3.0 的 parts 是**文件路径**（`data: ['items.json']`）：目标表名 = 文件名去掉 `.json`。
      const abs = path.join(plugin.dir, ...String(rel).split('/'));
      const table = path.basename(String(rel)).replace(/\.json$/i, '');
      let raw;
      try { raw = read(abs); } catch (e) { errors.push({ pack: plugin.id, code: 'CONTENT_FILE_MISSING', reason: `"${rel}" is declared in the manifest but not readable (${e && e.message ? e.message : e})` }); continue; }
      try { contributions.push({ packId: plugin.id, table, data: JSON.parse(raw) }); } catch (e) { errors.push({ pack: plugin.id, code: 'CONTENT_FILE_BAD_JSON', reason: `"${rel}" is not valid JSON (${e && e.message ? e.message : e})` }); }
    }
  }
  return { contributions, errors };
}
