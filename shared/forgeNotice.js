// shared/forgeNotice.js — the authorship stamp the Forge editor writes into every Option it saves.
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

/** The readout the editor shows: who made this Option, and when. */
export function forgeMetaLine(spec) {
  const m = isPlain(spec) && isPlain(spec._meta) ? spec._meta : null;
  if (!m) return '（这个 Option 还没有署名信息：在编辑器里保存一次即可写入）';
  return `${m.author} · 创建 ${String(m.created).slice(0, 10)} · 最近修改 ${String(m.modified).slice(0, 10)} · ${m.source}`;
}
