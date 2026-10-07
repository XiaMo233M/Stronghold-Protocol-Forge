// shared/kitAuthoring.js — checking a workshop BEHAVIOUR-LAYER kit (`<pack>/kits/<chessId>.js`).
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
//
// A kit is code, not data, so it cannot be "derived". But most of the ways a kit goes wrong are STATIC, and every one of
// them fails SILENTLY in game — which is exactly the class of bug the rest of this project's authoring layer exists to
// catch. The three rules below are quoted from the engine, not invented:
//
//   1. the module must default-export the kit function     server/workshop.js loadWorkshopKits — no default export means
//                                                          the whole file is reported and skipped
//   2. it must be SELF-CONTAINED (no import)               the same file is loaded twice: the server by real path, the
//                                                          browser by URL. `../../sim/…` resolves for one and not the
//                                                          other, so no relative specifier can work for both
//   3. it must be DETERMINISTIC and environment-free         it runs in the player's browser (SP_COMBAT=client) and the
//                                                          server recomputes the same battle to verify the result. A
//                                                          Math.random() or a Date.now() makes the two disagree and the
//                                                          player's result is REJECTED — with a reason that looks
//                                                          nothing like "you used Math.random"
//
// And one that is specific to the hook bus: `battle.on(name, fn)` accepts ANY string (server/sim/Battle.js:583) and
// `emit()` only fires the names something actually emits (:623). So `battle.on('beforeAttck', …)` registers cleanly,
// never fires, and nothing anywhere reports it. HOOK_EVENTS below is the engine's real emit vocabulary, pinned to the
// source by a drift guard (test/kitAuthoring.test.js), so a typo can be answered with a suggestion.
//
// A kit may also declare its OWN event under a namespace (`battle.emit('mypack:ready')`), which is how the official
// content does it (`nearl2:knockdown`). Such a name is legal as long as the same file emits it — so the check is
// "the engine emits it, or this file emits it".

/**
 * Every event the engine emits (server/sim + public/js), minus the engine-internal ones a kit has no reason to hook.
 * Drift-guarded against the real sources; see the test.
 */
export const HOOK_EVENTS = Object.freeze([
  'ammoUsed', 'attack', 'bardRegen', 'battleEnd', 'battleStart', 'beforeAttack', 'beforeStatus', 'blocked',
  'boomerangCaught', 'damaged', 'death', 'deploy', 'dodge', 'dollSwap', 'dollSwitch', 'elementBurst', 'elementHit',
  'enemyAttackStart', 'enemyLeak', 'enemySpawn', 'fatal', 'heal', 'hit', 'hpDamage', 'kill', 'layerGain', 'lpLoss',
  'merchantPay', 'nearl2:knockdown', 'palsyTrigger', 'skillEnd', 'skillStart', 'spGain', 'statusApplied', 'summonKill',
  'tick',
]);

/** Names that make a kit non-deterministic or environment-bound (rule 3), with why each one is a problem. */
export const KIT_FORBIDDEN_GLOBALS = Object.freeze([
  ['Math.random', 'the server recomputes this battle to verify the result — a different random draw rejects the player'],
  ['Date.now', 'wall-clock time differs between the player and the server'],
  ['performance.now', 'wall-clock time differs between the player and the server'],
  ['new Date', 'wall-clock time differs between the player and the server'],
  ['fetch', 'a kit runs inside the battle loop, in the player\'s browser — it must not talk to the network'],
  ['XMLHttpRequest', 'a kit runs inside the battle loop, in the player\'s browser — it must not talk to the network'],
  ['WebSocket', 'a kit runs inside the battle loop, in the player\'s browser — it must not talk to the network'],
  ['document', 'a kit has no DOM (the sim also runs headless on the server)'],
  ['window', 'a kit has no window (the sim also runs headless on the server)'],
  ['localStorage', 'a kit must not read or write player-machine state'],
  ['setTimeout', 'the battle has its own clock (battle.after / battle.every) — a real timer desynchronises it'],
  ['setInterval', 'the battle has its own clock (battle.after / battle.every) — a real timer desynchronises it'],
]);

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** The wire-id charset shared/protocol.js uses, which a kit file name must also satisfy. */
const ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

/**
 * Remove comments, keeping string literals intact. A char-wise scan rather than a regex, because a `//` inside a string
 * (`'https://…'`) must not start a comment. The hook scan needs this: the shipped example kit *documents*
 * `battle.on(...)` in its header, and a prose mention must not be read as a registration.
 */
function stripComments(src) {
  const text = String(src || '');
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; out += ' '; continue; }
    out += c;
  }
  return out;
}

/** Strip comments AND string bodies, so a check never fires on prose or on a string that merely names a global. */
function stripCommentsAndStrings(src) {
  return stripComments(src)
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/**
 * Does `code` reference `needle` as a bare identifier or property chain — not as part of a longer name (`myDocument`,
 * `Math.randomize`) and not as somebody else's property (`battle.setTimeout`)?
 *
 * A regex would need a lookbehind for the "part of a longer name" half, and this repo bans lookbehind (older browser
 * engines do not support it), so the check walks the matches instead.
 */
function mentionsIdentifier(code, needle) {
  for (let at = code.indexOf(needle); at >= 0; at = code.indexOf(needle, at + 1)) {
    const before = at > 0 ? code[at - 1] : '';
    const after = code[at + needle.length] ?? '';
    if (!/[\w$]/.test(before) && before !== '.' && !/[\w$]/.test(after)) return true;
  }
  return false;
}

/**
 * The event names a kit source registers and emits, as literal strings only. Comments are removed first, so the
 * documentation in a kit's own header is not mistaken for code.
 * @param {string} src
 * @returns {{ on: string[], emit: string[], dynamicOn: number }}
 */
export function hookNamesInSource(src) {
  const text = stripComments(src);
  const grab = (re) => [...text.matchAll(re)].map((m) => m[2]);
  const on = grab(/\.(?:on|hasHook)\(\s*(['"])([^'"]*)\1/g);
  const emit = grab(/\.emit\(\s*(['"])([^'"]*)\1/g);
  const allOn = [...text.matchAll(/\.(?:on|hasHook)\(/g)].length;
  return { on, emit, dynamicOn: Math.max(0, allOn - on.length) };
}

/** Levenshtein distance, capped — only used to suggest "did you mean …?". */
function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** The known event closest to `name`, or null. A suggestion is only useful when it is close. */
export function nearestEvent(name, known = HOOK_EVENTS) {
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(name, k);
    if (d < bestD) { bestD = d; best = k; }
  }
  const limit = name.length <= 4 ? 1 : name.length <= 8 ? 2 : 3;
  return bestD <= limit ? best : null;
}

/**
 * Static validation of one kit source.
 *
 * @param {string} source the file's text
 * @param {{ id?: string, ownChessIds?: Iterable<string>, overrides?: string[], knownEvents?: Iterable<string> }} [opts]
 *   `ownChessIds` = the chess ids THIS pack contributes, `overrides` = the pack's declared
 *   `"chess:<id>"` replacements. Together they reproduce loadWorkshopKits' ownership rule.
 * @returns {Array<{ field: string, code: string, message: string, severity: string, hint?: string }>}
 */
export function validateKit(source, opts = {}) {
  const out = [];
  const err = (field, code, message, hint) => out.push({ field, code, message, severity: 'error', ...(hint ? { hint } : {}) });
  const warn = (field, code, message, hint) => out.push({ field, code, message, severity: 'warning', ...(hint ? { hint } : {}) });
  const id = opts.id ?? '';
  if (!ID_RE.test(id)) err('id', 'BAD_KIT_ID', `"${id}" is not a usable kit id`, 'the file name (without .js) must equal the chess id it belongs to');

  if (typeof source !== 'string' || !source.trim()) {
    err('source', 'EMPTY_KIT', 'the kit file is empty');
    return out;
  }
  const text = source;

  // ---- ownership: the same rule loadWorkshopKits enforces, so the editor refuses before the server silently drops it
  if (ID_RE.test(id)) {
    const own = new Set(opts.ownChessIds || []);
    const declared = new Set(Array.isArray(opts.overrides) ? opts.overrides : []);
    if (!own.has(id) && !declared.has(`chess:${id}`)) {
      err('id', 'KIT_NO_TARGET',
        `no chess record carries the id "${id}", so this kit would never be used`,
        `name the file after an operator this pack defines (e.g. chess_ws_<slug>_a), or add "chess:${id}" to pack.json overrides to replace an official one`);
    }
  }

  // ---- rule 1: the default export is what the engine calls
  if (!/\bexport\s+default\b/.test(text) && !/\bmodule\.exports\b/.test(text)) {
    err('source', 'NO_DEFAULT_EXPORT', 'a kit must default-export the kit function (bb, chess, def) => Kit',
      'the loader reads mod.default, so the file is reported and skipped without it');
  }

  // ---- rule 2: self-contained. Checked on the COMMENT-STRIPPED text, because the rule itself is worth explaining in
  // the file's own header (the shipped example kit does exactly that).
  const code = stripCommentsAndStrings(text);
  if (/^\s*import\s|\bfrom\s+['"]|^\s*export\s+\{[^}]*\}\s*from\s+['"]/m.test(code) || /\brequire\s*\(/.test(code)) {
    err('source', 'KIT_IMPORT', 'a kit must not import or require anything — it has to be self-contained',
      'the same file is loaded by the server (by real path) and by the browser (by URL), so no relative path works for both; use only the battle and the (bb, chess, def) arguments');
  }

  // ---- rule 3: deterministic and environment-free
  for (const [needle, why] of KIT_FORBIDDEN_GLOBALS) {
    if (mentionsIdentifier(code, needle)) {
      warn('source', 'KIT_NONDETERMINISTIC', `"${needle}" makes this kit non-deterministic or environment-bound`, `${why}. Use battle.rng for randomness and the battle clock for time.`);
    }
  }

  // ---- the hook bus: a name nothing emits never fires, and nothing reports it
  const known = new Set(opts.knownEvents ? [...opts.knownEvents] : HOOK_EVENTS);
  const { on, emit, dynamicOn } = hookNamesInSource(text);
  const emitted = new Set(emit);
  for (const name of on) {
    if (known.has(name) || emitted.has(name)) continue;
    // a namespaced name (`pack:event`) is a kit declaring its own event — legal when this file emits it
    const near = nearestEvent(name, [...known]);
    warn(`hooks.${name}`, 'HOOK_UNKNOWN_EVENT',
      `nothing emits "${name}", so this handler never runs`,
      near ? `did you mean "${near}"?` : 'the event names a kit may hook are listed in shared/kitAuthoring.js HOOK_EVENTS');
  }
  if (dynamicOn > 0) {
    warn('hooks', 'HOOK_DYNAMIC_NAME', `${dynamicOn} hook registration(s) use a computed event name`, 'a computed name cannot be checked — a typo there never fires and cannot be reported');
  }

  return out;
}

/** The errors of a validation result. */
export const kitErrors = (issues) => (Array.isArray(issues) ? issues.filter((i) => i.severity === 'error') : []);

/** A one-line readout for the editor / CLI. */
export const kitSummaryLine = (source) => {
  const { on } = hookNamesInSource(source);
  const unique = [...new Set(on)];
  return `${unique.length ? `钩子 ${unique.join(', ')}` : '无钩子'}`;
};
