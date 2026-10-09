// shared/kitImports.js — the IMPORT SURFACE of a workshop behaviour-layer kit (`<pack>/kits/<chessId>.js`).
// (i18n-ignore-file: 作者/加载器/编辑器共用的规则文本 —— 给作者、编辑器与 AI 读的错误说明，不是客户端界面文案)
//
// WHY THIS FILE EXISTS (gap ④, docs/design/mod-layer.md §27.12)
//
// A kit is one file that is loaded TWICE from two different roots:
//   * the SERVER, by real path  — `server/workshop.js loadWorkshopKits()`: `import(pathToFileURL(file))`
//   * the BROWSER, by URL       — `public/js/battle/runner.js loadSpecKits()`: `import('/workshop-kits/<pack>/<id>.js?v=…')`
// A relative specifier cannot be right for both: `../shared/tier1.js` means `server/sim/content/kits/shared/tier1.js` to
// the server and `/workshop-kits/shared/tier1.js` to the browser. That is the whole reason `KIT_IMPORT` used to reject
// every import (`shared/kitAuthoring.js`).
//
// The fix is a WHITELIST plus a prefix that resolves in BOTH worlds — `@kit/tier1.js`:
//   * server: `rewriteKitImports()` turns each whitelisted specifier into the real `file:` URL before the import;
//   * browser: `kitImportMap()` is declared in `public/index.html`'s import map, so no rewriting happens there.
// One table (`KIT_IMPORT_FILES`) feeds both, so the two ends cannot drift — and `test/kitImports.test.js` reads
// `public/index.html` and requires it to agree with the table.
//
// WHAT IS *NOT* ALLOWED, and why the rule is narrow: only the files below. A kit may reach the engine's kit SDK and the
// three pure helpers that SDK itself is built on. It may not reach the match, the lobby, the HTTP entry, the net layer,
// the file system, or anything under `public/` — the same boundary `tools/check-imports.mjs` draws for `server/sim`,
// applied to third-party code.
//
// The scan/parse/rewrite primitives live here, not in `shared/kitAuthoring.js`, because the LOADER must reach the same
// verdict as the VALIDATOR: `server/workshop.js` imports `kitImportIssues()` from this file, so the editor cannot pass
// something the loader then refuses (docs/design/mod-layer.md §27.3).

/** The only prefixes a kit may import through. A specifier that starts with neither is refused. */
export const KIT_IMPORT_PREFIXES = Object.freeze(['@kit/', '@sim/']);

/**
 * The whitelist. `specifier` is what the author writes; `file` is the real path, workspace-relative and POSIX — the
 * server resolves it against the repository root and the browser resolves the same string through the import map.
 * Adding a line here is the ONLY way to open a new module, and it opens it on both ends at once.
 */
export const KIT_IMPORT_FILES = Object.freeze([
  // the kit SDK: the same helpers the official kits are written against
  { specifier: '@kit/tier1.js', file: 'server/sim/content/kits/shared/tier1.js' },
  { specifier: '@kit/tier2.js', file: 'server/sim/content/kits/shared/tier2.js' },
  { specifier: '@kit/tier3.js', file: 'server/sim/content/kits/shared/tier3.js' },
  { specifier: '@kit/tier4.js', file: 'server/sim/content/kits/shared/tier4.js' },
  { specifier: '@kit/tier5.js', file: 'server/sim/content/kits/shared/tier5.js' },
  { specifier: '@kit/tier6.js', file: 'server/sim/content/kits/shared/tier6.js' },
  { specifier: '@kit/summoner.js', file: 'server/sim/content/kits/shared/summoner.js' },
  // the three pure engine helpers the SDK is built on (and the ones a community kit already imported by relative path)
  { specifier: '@sim/constants.js', file: 'server/sim/constants.js' },
  { specifier: '@sim/dir.js', file: 'server/sim/dir.js' },
  { specifier: '@sim/targeting.js', file: 'server/sim/targeting.js' },
]);

/** specifier → file, for the loader and the import-map generator. */
export const KIT_IMPORT_TARGETS = Object.freeze(new Map(KIT_IMPORT_FILES.map((e) => [e.specifier, e.file])));

/** The list a reason/hint quotes, so the message and the table can never disagree. */
export const KIT_IMPORT_ALLOWED = Object.freeze(KIT_IMPORT_FILES.map((e) => e.specifier));

/** One line naming every allowed specifier — the "here is what you may write instead" half of an error. */
export const kitImportAllowedText = () => KIT_IMPORT_ALLOWED.join(', ');

/**
 * Blank out comments, keeping string literals AND the newlines (so an index into the result is an index into the input).
 * A char-wise scan rather than a regex: a `//` inside a string (`'https://…'`) must not start a comment, and an import
 * specifier is itself a string literal that has to survive.
 */
function maskComments(src) {
  const text = String(src || '');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      for (i++; i < text.length; i++) {
        out += text[i];
        if (text[i] === '\\') { i++; out += text[i] ?? ''; continue; }
        if (text[i] === q) break;
      }
      continue;
    }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } out += '\n'; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      i++;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Every STATIC import/export-from of a source, in source order.
 *
 * `specifier` is the raw text between the quotes, `specStart` its index in the SOURCE (so a rewrite is a slice), `quote`
 * the quote character the author used, and `declStart` the index of the statement's first character (for `import` that
 * is the `i` itself; for `export … from` it is the `export`, which is what `declaration` starts at).
 *
 * The statement regex is anchored to `(?:^|[;}\s])` so a line comment cannot reach it, and the preceding character is
 * put back with `m[0].slice(0, m[0].length - m[1].length)`. Dynamic `import(` is deliberately NOT matched here (its
 * specifier is an expression); `kitImportIssues` reports it separately.
 * @param {string} src
 * @returns {Array<{ specifier: string, specStart: number, quote: string, declaration: string, declStart: number }>}
 */
export function kitImportDeclarations(src) {
  const text = String(src || '');
  const code = maskComments(text);
  const re = /(?:^|[;}\s])((?:import|export)\s(?:[\s\S]*?)\sfrom\s*(['"])([^'"\n]+)\2)/g;
  const out = [];
  for (const m of code.matchAll(re)) {
    const declaration = m[1];
    const prefix = m[0].length - declaration.length;
    const declStart = m.index + prefix;
    const quote = m[2];
    const specifier = m[3];
    const from = declaration.lastIndexOf(' from ');
    const at = from < 0 ? -1 : declaration.indexOf(quote, from);
    if (at < 0) continue;
    out.push({ specifier, specStart: declStart + at + 1, quote, declaration, declStart });
  }
  return out;
}

/** Dynamic `import(…)` expressions (a specifier that is not a static string, and therefore not checkable). */
export function kitDynamicImports(src) {
  const text = String(src || '');
  const code = maskComments(text);
  const re = /(?:^|[^.\w$])import\s*\(/g;
  const out = [];
  for (const m of code.matchAll(re)) {
    const at = m.index + (m[0].startsWith('import') ? 0 : 1);
    out.push({ at });
  }
  return out;
}

/** `require(…)` calls — a CommonJS call neither the browser nor an ESM loader can serve. */
export function kitRequireCalls(src) {
  const text = String(src || '');
  const code = maskComments(text);
  const re = /(?:^|[^.\w$])require\s*\(/g;
  const out = [];
  for (const m of code.matchAll(re)) out.push({ at: m.index + (m[0].startsWith('require') ? 0 : 1) });
  return out;
}

/**
 * The import problems of one kit source, in the SAME shape for the validator and the loader: `code` is the machine-
 * readable verdict, `reason` the Chinese sentence a player/maintainer reads. Nothing else about a kit is judged here —
 * this is only the import surface.
 *
 * `decls` is an optional pre-computed `kitImportDeclarations(src)` — the loader already has it (it decides from it
 * whether the source needs rewriting), so passing it in keeps the scan to one per file.
 * @param {string} src
 * @param {ReturnType<typeof kitImportDeclarations>} [decls]
 * @returns {Array<{ code: string, reason: string }>}
 */
export function kitImportIssues(src, decls = null) {
  const out = [];
  if (kitDynamicImports(src).length) {
    out.push({
      code: 'KIT_IMPORT',
      reason: `禁止动态 import()：它无法被双端静态解析（服务端按真实路径、浏览器按 URL），只允许写在文件顶部的静态 import；白名单：${kitImportAllowedText()}`,
    });
  }
  if (kitRequireCalls(src).length) {
    out.push({
      code: 'KIT_IMPORT',
      reason: `禁止 require()：kit 两端都按 ES 模块加载（服务端 import()、浏览器 import），CommonJS 在两端都不存在；白名单：${kitImportAllowedText()}`,
    });
  }
  for (const d of (decls || kitImportDeclarations(src))) {
    if (KIT_IMPORT_TARGETS.has(d.specifier)) continue;
    out.push({ code: 'KIT_IMPORT', reason: `import "${d.specifier}" 不在白名单里：${kitImportUnavailableReason(d.specifier)}` });
  }
  return out;
}

/**
 * Why one specifier is refused, with the reason that fits it — a path that escapes, an absolute path, a whitelisted
 * module the author misspelled, or a module that simply is not on the list. Every branch ends by naming the whitelist,
 * because "you may not do this" without "here is what you may do" is what makes an author guess.
 */
export function kitImportUnavailableReason(specifier) {
  const s = String(specifier ?? '');
  const allowed = `白名单：${kitImportAllowedText()}`;
  if (s.startsWith('..') || s.includes('/../') || s === '..') {
    return `相对路径（含 ".."）无法同时在服务端与浏览器成立，且路径穿越一律拒绝；${allowed}`;
  }
  if (s.startsWith('.')) return `相对路径无法同时在服务端与浏览器成立；${allowed}`;
  if (s.startsWith('/')) return `绝对路径无法同时在服务端与浏览器成立；${allowed}`;
  if (s.startsWith('@kit/') || s.startsWith('@sim/')) {
    return `模块名 "${s.slice(s.indexOf('/') + 1)}" 未开放（前缀合法，但这个文件不在白名单里）；${allowed}`;
  }
  if (s.startsWith('@')) return `未知前缀 "${s.slice(0, s.indexOf('/') + 1 || undefined)}"；${allowed}`;
  return `裸模块名 "${s}" 未开放（kit 只能 import 引擎的 kit SDK 与三个纯函数模块）；${allowed}`;
}

/** The allowed file for a specifier, or null. */
export const kitImportTarget = (specifier) => KIT_IMPORT_TARGETS.get(String(specifier)) || null;

/**
 * The import map a browser needs so the SAME source works there — `{"@kit/": "/sim/content/kits/shared/", "@sim/": "/sim/"}`.
 *
 * It is PREFIX-ONLY on purpose. The obvious alternative — one entry per specifier, `"@kit/tier1.js": "/sim/content/
 * kits/shared/tier1.js"` — duplicates the table into `public/index.html` and rots the moment a file moves; a prefix map
 * says "this namespace is this served subtree" once. The file a specifier resolves to is still checked, but in
 * `test/kitImports.test.js`: it resolves every whitelisted specifier through this map and requires the served URL to
 * exist on disk under the `/sim/` mount, so a typo in the table is a red test rather than a 404 at runtime.
 * @returns {Record<string, string>}
 */
export function kitImportMap() {
  /** @type {Record<string, string>} */
  const map = {};
  for (const prefix of KIT_IMPORT_PREFIXES) {
    const first = KIT_IMPORT_FILES.find((e) => e.specifier.startsWith(prefix));
    if (!first) continue;
    const tail = first.specifier.slice(prefix.length);
    map[prefix] = kitImportBrowserUrl(first.file.slice(0, first.file.length - tail.length));
  }
  return map;
}

/**
 * The URL a browser fetches a whitelisted module from — the `/sim/` mount (`server/http/static.js`: `/sim/` →
 * `server/sim/`, `.js` only). The server uses the real path instead; both come from the same table row, which is what
 * makes `@kit/tier1.js` mean the same file on both ends.
 */
export const kitImportBrowserUrl = (file) => `/${String(file).replace(/^server\/sim\//, 'sim/')}`;

/**
 * The NARROW rewrite the server performs before importing a kit: every whitelisted specifier becomes the real URL the
 * server would have resolved, and every other byte of the file is left alone (so a hash taken from the author's source
 * is still a hash of what the author wrote — §27.2 hashes `kits/*.js` bytes, never this output).
 *
 * Only whitelisted specifiers are touched. A refused specifier is NOT rewritten: the loader reports it instead, so a
 * broken import fails with the reason rather than with a module-resolution stack trace.
 * @param {string} src
 * @param {(file: string) => string} urlOf workspace-relative file → URL (the loader passes `pathToFileURL`)
 * @returns {string}
 */
export function rewriteKitImports(src, urlOf) {
  const text = String(src || '');
  const decls = kitImportDeclarations(text);
  if (!decls.length) return text;
  let out = '';
  let at = 0;
  for (const d of decls) {
    const file = KIT_IMPORT_TARGETS.get(d.specifier);
    if (!file) continue;                                   // refused: left for the loader to report
    const url = String(urlOf(file));
    out += text.slice(at, d.specStart) + url;
    at = d.specStart + d.specifier.length;
  }
  return out + text.slice(at);
}
