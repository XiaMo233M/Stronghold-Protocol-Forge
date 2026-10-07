// shared/forgeNotice.js — the authorship stamp the Forge editor writes into every Option it saves.
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// An "Option" is what an author creates with the editor: a map, a monster, a wave table, an item, an operator. The
// editor's copyright section (README「著作权声明」) says an Option belongs to the person who created it, and that
// collecting other people's Options from public sources to repackage and resell them is not allowed. A statement in a
// README cannot travel with a file, so every saved spec carries the same statement in a `_meta` block — that is the
// whole point: whoever opens the file later sees who made it and on what terms, without having to find this repository.
//
// SCOPE — stated precisely, because it is a licensing boundary: `_meta` describes the OPTION (creative content). It is
// NOT a further restriction on the PROGRAM. The code stays GPL-3.0-or-later and `_meta` adds nothing to its terms;
// nothing here narrows anyone's GPL rights. Keeping that line sharp is what makes this notice GPL-compatible.
//
// `_meta` lives only in the SOURCE spec (`<pack>/*-specs/*.json`). Every derive* function builds its output record
// field by field, so `_meta` can never reach the generated artifact the game reads — pinned by test.
//
// A kit (`<pack>/kits/<chessId>.js`) is the one Option that is a file of CODE rather than a JSON object, so it cannot
// carry a `_meta` field — an object literal in a module is code to evaluate, not data to read. It carries the same
// notice in a comment HEADER instead (`forgeHeader` / `parseForgeHeader` / `stampForgeHeader` at the bottom of this
// file): one machine-readable marker line, then the identical prose. Same requirement, different container.

/** Written into `_meta.source`, so a file found in the wild can be traced back to this editor. */
export const FORGE_SOURCE = 'Stronghold-Protocol-Forge';
/** Bumped when the shape of `_meta` changes, so a reader can tell an old stamp from a new one. */
export const FORGE_META_SCHEMA = 1;

const COPYRIGHT_ZH = '本 Option 的著作权归创建它的作者本人所有。创作者可自由分享、分发自己的 Option，并可通过其获得合理回报。';
const COPYRIGHT_EN = 'This Option is the property of the author who created it. Creators may freely share and distribute their own Options and may reasonably profit from them.';
const ANTI_RESALE_ZH = '禁止未经授权从公开渠道收集他人 Option 并打包、转售或批量分发；转载、整合或二次分发他人 Option 必须保留原作者署名与来源信息。';
const ANTI_RESALE_EN = 'No one may, without authorization, collect Options created by others from public sources and package, resell, or bulk-distribute them. Any redistribution must retain the original author\'s attribution and source information.';
const SCOPE_ZH = '本声明只针对 Option 创作内容，不改变本项目代码的 GPL-3.0-or-later 授权，也不附加任何限制。';

/** The full statement, for embedding where a file can carry prose (a kit's header comment, a pack's README). */
export function forgeNoticeText() {
  return [
    `${COPYRIGHT_ZH}\n${COPYRIGHT_EN}`,
    `${ANTI_RESALE_ZH}\n${ANTI_RESALE_EN}`,
    SCOPE_ZH,
  ].join('\n\n');
}

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** An ISO-8601 instant, or null when the value is not one (a hand-edited `created` must not poison a re-save). */
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v);
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The `_meta` block for an Option.
 *
 * `created` is the FIRST time the Option was saved and is preserved across edits — an author who reopens and tweaks a
 * map must not have its creation date reset, which is exactly what a naive `created: now` would do.
 *
 * @param {{ author?: string|null, packId?: string|null, now?: string, previous?: object|null }} [opts]
 *   `previous` is the `_meta` already in the spec file (or the whole previous spec).
 * @returns {object}
 */
export function forgeMeta(opts = {}) {
  const prev = isPlain(opts.previous) ? (isPlain(opts.previous._meta) ? opts.previous._meta : opts.previous) : {};
  const now = isIso(opts.now) ? opts.now : new Date().toISOString();
  const author = clean(opts.author) ?? clean(prev.author) ?? '未署名 (anonymous)';
  const pack = clean(opts.packId) ?? clean(prev.pack) ?? null;
  return {
    schema: FORGE_META_SCHEMA,
    source: FORGE_SOURCE,
    author,
    pack,
    // the author's own creation instant survives every later save
    created: isIso(prev.created) ? prev.created : now,
    modified: now,
    copyright: { zh: COPYRIGHT_ZH, en: COPYRIGHT_EN },
    antiResale: { zh: ANTI_RESALE_ZH, en: ANTI_RESALE_EN },
    scope: SCOPE_ZH,
  };
}

/**
 * A copy of `spec` carrying the stamp. Never mutates the input (the caller may still be deriving from it).
 * A non-object spec is returned untouched — the save path reports that as an error anyway.
 * @param {object} spec
 * @param {Parameters<typeof forgeMeta>[0]} [opts]
 */
export function withForgeMeta(spec, opts = {}) {
  if (!isPlain(spec)) return spec;
  return { ...spec, _meta: forgeMeta({ ...opts, previous: opts.previous ?? spec._meta ?? null }) };
}

// ---- the FILE HEADER (a kit is a `.js` file, so its stamp is a comment) -----------------------------
//
// The marker is ONE documented line, because `created` has to be read back on every later save and guessing at prose is
// exactly how a creation date gets silently reset:
//
//     // @forge created=<iso> modified=<iso> pack=<packId> source=Stronghold-Protocol-Forge author=<name>
//
// `author` comes LAST and takes the rest of the line, so a name containing a space ("John Doe") round-trips whole.

/** The marker that identifies a Forge-written file header. */
export const FORGE_HEADER_TAG = '@forge';

/** The marker line itself: a WHOLE `//` comment line, CRLF-safe. */
const FORGE_HEADER_LINE_RE = /^\/\/[ \t]*@forge[ \t]+[^\r\n]*/m;

/** The marker line for this save, honouring the `created` an earlier save wrote. */
function forgeHeaderLine(previous, opts = {}) {
  const prev = parseForgeHeader(previous);
  const now = isIso(opts.now) ? opts.now : new Date().toISOString();
  const author = clean(opts.author) ?? clean(prev && prev.author) ?? '未署名 (anonymous)';
  const pack = clean(opts.packId) ?? clean(prev && prev.pack) ?? null;
  // the author's own creation instant survives every later save — the same rule `forgeMeta` follows
  const created = prev && isIso(prev.created) ? prev.created : now;
  const fields = [`created=${created}`, `modified=${now}`];
  if (pack) fields.push(`pack=${pack}`);
  fields.push(`source=${FORGE_SOURCE}`, `author=${author}`);
  return `// ${FORGE_HEADER_TAG} ${fields.join(' ')}`;
}

/**
 * Read the Forge header out of a file's text, or null when it has none.
 * A hand-edited `created`/`modified` that is not an instant reads as absent, so it cannot poison the next save.
 * @param {string} source
 * @returns {{ created: string|null, modified: string|null, pack: string|null, source: string|null, author: string|null }|null}
 */
export function parseForgeHeader(source) {
  const text = typeof source === 'string' ? source : '';
  const line = FORGE_HEADER_LINE_RE.exec(text);
  if (!line) return null;
  const rest = line[0].replace(/^\/\/[ \t]*/, '').slice(FORGE_HEADER_TAG.length).trim();
  // every field but `author` is space-free, so it can be pulled by name; `author` ends the line and keeps its spaces
  const named = /(?:^|\s)author=([\s\S]*)$/.exec(rest);
  const head = named && typeof named.index === 'number' ? rest.slice(0, named.index) : rest;
  const field = (key) => {
    const hit = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(head);
    return hit ? hit[1] : null;
  };
  const created = field('created');
  const modified = field('modified');
  return {
    created: isIso(created) ? created : null,
    modified: isIso(modified) ? modified : null,
    pack: field('pack'),
    source: field('source'),
    author: named && named[1].trim() ? named[1].trim() : null,
  };
}

/**
 * The complete header block for `previous`: the marker line, then the notice as `//` comments. Ends with a newline, so
 * it can be prepended to a file's text directly.
 * @param {string} previous the text to read an earlier `created`/`author` out of (usually the file being re-saved)
 * @param {{ author?: string|null, packId?: string|null, now?: string }} [opts]
 */
export function forgeHeader(previous, opts = {}) {
  const prose = forgeNoticeText().split('\n').map((line) => (line.trim() ? `// ${line}` : '//'));
  return [
    forgeHeaderLine(previous, opts),
    '//',
    '// 本文件由 Forge 工坊编辑器保存：署名与使用声明随文件一起分发（著作权声明见 README「著作权声明」）。',
    '//',
    ...prose,
    '',
  ].join('\n');
}

/**
 * Stamp a file's text with the Forge header, idempotently.
 *
 * Two rules the caller relies on, so they are enforced here rather than at each call site:
 *   * NEVER double-stamp — a text that already carries a marker gets that one line refreshed (`modified` moves,
 *     `created` stays), so the notice below it cannot stack up;
 *   * NEVER strip what the author wrote — the prepend path puts our block ABOVE the author's own leading comment, and
 *     the refresh path rewrites exactly one line, so no other byte of their file is touched.
 *
 * @param {string} source the text to write (a freshly typed one, or the previous revision read back from disk)
 * @param {{ author?: string|null, packId?: string|null, now?: string, previous?: string }} [opts] `previous` is only
 *   consulted when `source` itself carries no marker — a caller that posts bare code must not reset `created`.
 * @returns {string}
 */
export function stampForgeHeader(source, opts = {}) {
  const text = typeof source === 'string' ? source : '';
  const onDisk = typeof opts.previous === 'string' ? opts.previous : '';
  const anchor = parseForgeHeader(text) ? text : onDisk;
  // a blank line keeps the author's own comment visibly theirs rather than glued to the notice prose
  if (!parseForgeHeader(text)) return forgeHeader(anchor, opts) + (text ? `\n${text}` : '');
  // a function replacement: an author name containing `$&` must not be read as a substitution pattern
  return text.replace(FORGE_HEADER_LINE_RE, () => forgeHeaderLine(anchor, opts));
}

/** The readout the editor shows: who made this Option, and when. */
export function forgeMetaLine(spec) {
  const m = isPlain(spec) && isPlain(spec._meta) ? spec._meta : null;
  if (!m) return '（这个 Option 还没有署名信息：在编辑器里保存一次即可写入）';
  return `${m.author} · 创建 ${String(m.created).slice(0, 10)} · 最近修改 ${String(m.modified).slice(0, 10)} · ${m.source}`;
}
