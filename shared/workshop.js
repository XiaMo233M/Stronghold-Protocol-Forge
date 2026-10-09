// shared/workshop.js — 创意工坊 (community workshop) pack format and the overlay merge, pure ESM shared by the server
// (i18n-ignore-file: 工坊作者层的校验与推导文本 —— 给作者、编辑器与 AI 读的规则说明（编辑器有自己的中英词典，见 docs/EDITOR.md），不是客户端界面文案)
// (the loader, the match data) and the browser (which reads the same merged /data/*.json).
//
// A workshop pack is DATA ONLY at this layer. It never edits `data/*.json` — the loader applies an additive overlay on
// top of the generated official data just before that object is frozen (server/data.js loadData). Two consequences are
// load-bearing for the whole feature:
//
//   1. `data/*.json` stays byte-identical, so the official integrity suite (test/data.test.js, incl. the offline
//      rebuild that must reproduce data/ byte-for-byte) keeps passing and the official content is a clean baseline.
//   2. The overlay runs BEFORE deepFreeze, so every consumer (match engine, sim, client) sees one ordinary merged
//      object and no downstream code needs to know workshop content exists.
//
// Overlay rule: **an id the official data already has is NOT replaced** unless the pack lists it in
// `pack.json.overrides` as `"<file>:<id>"`. Additive by default, explicit to override — a pack that silently redefines
// an official operator would otherwise corrupt every match on the server.
//
// Pack layout (`workshop/<packId>/`):
//   pack.json        { id, name, version, author, license, description, gameVersion, content: [file…], overrides: [] }
//   chess.json       { [chessId]:  record }   ← same shape as data/chess.json
//   items.json enemies.json stages.json waves.json tokens.json bosses.json factions.json   (any file in `content`)
//
// The behaviour layer (a pack's `kits/*.js`, wired to the battle.on(...) hook bus) is deliberately NOT part of this
// module: it is code, it is loaded by the server only, and it is documented in docs/WORKSHOP.md.

/** Data files a pack may contribute to. Deliberately a conservative subset of data/: `config` is excluded because a
 * pack that rewrote the economy or the round schedule would change the rules rather than the content. */
export const WORKSHOP_CONTENT_FILES = Object.freeze([
  'chess', 'units', 'items', 'enemies', 'stages', 'waves', 'tokens', 'bosses', 'factions', 'garrisons', 'bands', 'bonds', 'effects', 'choices',
]);

/** Files whose records are keyed by an id field that must equal the map key (catches copy-paste mistakes in a pack). */
const ID_FIELD_BY_FILE = Object.freeze({
  chess: 'chessId', units: 'charId', items: 'id', enemies: 'key', stages: 'stageId', waves: 'templateId',
  tokens: 'tokenId', bosses: 'bossId', factions: 'factionId', garrisons: 'garrisonId',
  bands: 'bandId', bonds: 'bondId', effects: 'effectId', choices: 'id',
});

/**
 * `units.json` 的一条干员记录**必须有的那几个字段**（docs/WORKSHOP.md §1.2）。
 *
 * 为什么只查这几个：这条记录是 `data/backups.json` 的 `units[charId]`，形状由**上游官方数据**决定（14 个顶层键，
 * 见 `test/modSurface.test.js`）。我们**不复制官方 schema** —— 复刻一份就是给自己加一个会漂移的第二真相，官方每次
 * 加字段我们都要跟一次；而下游（`server/sim`、`server/match`）真正读的也只是这几个键。其余字段一律照抄
 * （与 `ART_TABLES` 同一个哲学：作者照抄官方条目，我们不重新发明形状）。
 *
 * 每一条的形状用一套**声明**写出来（名字 + 一个判据 + 缺了它下游会怎样），所以校验、拒绝码与提示文案只有一个来源。
 */
export const UNIT_REQUIRED_FIELDS = Object.freeze([
  {
    key: 'charId',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_CHAR_ID',
    detail: 'must be a non-empty string (it is how the client asks for this operator\'s data)',
  },
  {
    key: 'name',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_NAME',
    detail: 'must be a non-empty string (the operator shows up nameless otherwise)',
  },
  {
    key: 'rarity',
    ok: (v) => Number.isInteger(v),
    code: 'UNIT_BAD_RARITY',
    detail: 'must be an integer (the star rating; the 自选池 screen draws it)',
  },
  {
    key: 'profession',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_PROFESSION',
    detail: 'must be a non-empty string (WARRIOR / SNIPER / … — the project\'s own profession names, not DEFENDER/VANGUARD)',
  },
  {
    key: 'subProfessionId',
    ok: (v) => typeof v === 'string' && v.length > 0,
    code: 'UNIT_MISSING_SUB_PROFESSION',
    detail: 'must be a non-empty string (the branch; `assets.prof.sub` carries its icon)',
  },
  {
    key: 'forms',
    ok: (v) => isPlainObj(v) && Object.keys(v).length > 0,
    code: 'UNIT_BAD_FORMS',
    detail: 'must be a non-empty object of "elite/level/skill/module" ranks (the operator has no stats without one)',
  },
]);

/** Pack ids: a short filesystem- and URL-safe slug (it names the directory under workshop/). */
export const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * 一条 `pack.json.overrides` 声明的形状：`"<文件>:<id>"`（例 `chess:chess_char_1_01_a`）。**只此一份**：
 * `normalizePackManifest` 下面用它过滤，编辑器的写入端与校验器用它拒绝（两处正则不一致的话，界面会写出一个
 * 加载器悄悄丢掉的声明 —— 那正是「写了等于没写」这一类静默失败）。
 */
export const OVERRIDE_ENTRY_RE = /^([a-z]+):([A-Za-z0-9_\-.:]{1,64})$/;

/**
 * The URL prefix a pack's own media is served under: `<prefix><packId>/<path inside that pack's assets/>`
 * (server/index.js serves the route, docs/WORKSHOP.md §5). One source of truth, because the voice URLs this module
 * writes into the data must be exactly the ones that route answers.
 */
export const WORKSHOP_MEDIA_PREFIX = '/workshop-assets/';
/** Record ids follow the wire-id charset (shared/protocol.js isId) so an id can travel in a message. */
const RECORD_ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

import { VOICE_SLOTS, VOICE_LANGS, DEFAULT_VOICE_LANG } from './constants.js';
import { isSupportTier } from './support.js';
import { isVersionRange } from './packs.js';
import { MOD_LAYERS } from './modIdentity.js';
import { requiredUnitForms } from './diy.js';

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (error, detail) => ({ ok: false, error, detail });
/** 一个可选的字符串字段：非空字符串就裁剪，其它一律 null（缺省与写错都读成「没声明」）。 */
const strField = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** 包内素材路径：相对、在包自己的 `assets/` 下、无穿越。语音、各类图标、外观素材共用这一条规则。 */
const isSafeAssetPath = (p) =>
  typeof p === 'string' && !!p && !p.startsWith('/') && !p.includes('\\')
  && !p.split('/').some((seg) => seg === '..' || seg === '.') && !/^[A-Za-z]:/.test(p);

/**
 * `pack.json.operators[<charId>]` 允许的两个列表字段。**只此一份**：形状校验（`normalizePackManifest`）与
 * 「盟约存不存在」那一步（`mergeWorkshopOperators`）读的是同一张表，两处不会漂移。
 *
 * 为什么 `bonds` 必须点名：盟约 id 写错时那条盟约条**永远不会出现**，而作者只会以为「盟约没生效」—— 静默失效
 * （与 `bondIcons` 同一个理由：一个没人读到的声明比一条报错坏得多）。
 */
const OPERATOR_LIST_FIELDS = Object.freeze(['powers', 'bonds']);

/**
 * 一个「字符串列表」字段（`operators[*].bonds` / `.powers`）：数组、每一项是非空字符串、去重、排序（键序是清单
 * 字节的一部分）。不是数组、或里面有一个不是字符串 → 拒绝，并指出**是哪一条的哪一个字段**。
 * @returns {{ ok: true, list: string[] } | { ok: false, detail: string }}
 */
function parseStringList(value, where) {
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list)) return { ok: false, detail: `${where} must be an array of ids` };
  const out = [];
  for (const id of list) {
    if (typeof id !== 'string' || !id.trim()) return { ok: false, detail: `${where}: "${String(id)}" is not a valid id` };
    const clean = id.trim();
    if (!out.includes(clean)) out.push(clean);
  }
  return { ok: true, list: out.sort() };
}

/**
 * 外观素材的三张表，以及每张表的条目允许带什么。
 *
 * 形状与 `data/assets.json` 里对应条目**1:1**，作者可以照抄官方条目（tools/assets 计划的产物）再改路径，所以这里
 * 只描述「哪些字段是路径、spine 在哪一层」，不重新发明一套 schema：
 *   * `urls`   —— 这个条目上直接是路径的字段（头像/立绘/图标）；
 *   * `strings`—— 原样抄过去的字符串字段（`enemies.spineAliasOf` 指向另一个怪物的模型、`tokens.owner` 是它属于谁）；
 *   * `spine`  —— `'sides'`：spine 在 `spine.front` / `spine.back` 两层下（chars）；`'flat'`：spine 就是条目上的
 *                 `spine` 字段（enemies / tokens）。
 *   * `flat`   —— 这一张表的**条目本身就是一条路径字符串**（不是"对象 + `urls` 字段"）。今天的成员是 `skills`
 *                 （技能图标）与 `profSub`（分支图标）：`assets.skills[key]` 与 `assets.prof.sub[key]` 的值**直接
 *                 就是路径字符串**（`data/assets.json` 实测），所以这里没有字段可列。谁赢与落盘位置由 `target`
 *                 给出（见 `mergeWorkshopFlatArt`）。
 */
export const ART_TABLES = {
  chars: { urls: ['avatar', 'avatarE2', 'portrait', 'portraitE2'], strings: [], spine: 'sides' },
  enemies: { urls: ['icon'], strings: ['spineAliasOf'], spine: 'flat' },
  tokens: { urls: ['avatar'], strings: ['owner'], spine: 'flat' },
  skills: { flat: true, target: ['skills'] },
  profSub: { flat: true, target: ['prof', 'sub'] },
};
/**
 * 一个 spine 对象里的路径字段、路径数组字段，以及原样抄过去但要查类型的字段。
 *
 * 这些类型**不是我们定的**，是 `data/assets.json` 里官方条目的实际类型（工具链产物，0.8.0 实测）：
 * `anims` 与 `animations` 都是**对象**（前者是"角色 → 动画名"的映射，后者是"动画名 → 时长"），
 * `events` 是**数组**（事件名列表，例如 `["OnAttack","OnStart"]`），`pma` 是布尔、`hits`/`bounds` 是对象。
 * 文档教作者「照官方条目抄」，所以这里必须与官方一致 —— 类型写反，一个正确的条目会被我们拒掉。
 */
export const ART_SPINE_URLS = ['skel', 'atlas'];
export const ART_SPINE_LISTS = ['textures'];
export const ART_SPINE_PASSTHROUGH = {
  pma: ['boolean'],
  anims: ['object'],
  animations: ['object'],
  events: ['array'],
  hits: ['object'],
  bounds: ['object', 'array'],
};
const ART_SPINE_FIELDS = [...ART_SPINE_URLS, ...ART_SPINE_LISTS, ...Object.keys(ART_SPINE_PASSTHROUGH)];

/** 一个 spine 对象（`{ skel, atlas, textures?, pma?, anims?, … }`）。`skel` 与 `atlas` 缺一不可：加载器是从 skel
 * 的路径**推出** atlas 的，清单里的 atlas 只用来做内存回收，写错不会报错 —— 所以形状这一层就要求它必须在。 */
function parseArtSpine(spine, where) {
  if (!isPlainObj(spine)) return { error: 'ART_BAD_SHAPE', detail: `${where} must be a spine object { skel, atlas, … }` };
  const out = {};
  for (const [key, value] of Object.entries(spine)) {
    if (!ART_SPINE_FIELDS.includes(key)) {
      return { error: 'ART_UNKNOWN_FIELD', detail: `${where}: "${key}" is not a spine field (${ART_SPINE_FIELDS.join(', ')})` };
    }
    if (ART_SPINE_URLS.includes(key)) {
      if (!isSafeAssetPath(value)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(value)}" must be a relative path inside assets/` };
      out[key] = value;
      continue;
    }
    if (ART_SPINE_LISTS.includes(key)) {
      if (!Array.isArray(value) || !value.length) return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a non-empty array of paths` };
      for (const p of value) {
        if (!isSafeAssetPath(p)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(p)}" must be a relative path inside assets/` };
      }
      out[key] = [...new Set(value)];
      continue;
    }
    const got = Array.isArray(value) ? 'array' : (value && typeof value === 'object' ? 'object' : typeof value);
    if (!ART_SPINE_PASSTHROUGH[key].includes(got)) {
      return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a ${ART_SPINE_PASSTHROUGH[key].join(' or ')}` };
    }
    out[key] = value;
  }
  for (const need of ART_SPINE_URLS) {
    if (!out[need]) return { error: 'ART_SPINE_INCOMPLETE', detail: `${where} needs both "skel" and "atlas"` };
  }
  return { spine: out, error: null };
}

/** 一张外观表里的一个条目：路径字段、原样字符串、以及（按表）嵌套或扁平的 spine。 */
function parseArtEntry(entry, where, shape) {
  // 扁平表（skills / profSub）：条目本身就是一条路径。`isSafeAssetPath` 由调用方判，好让拒绝码是 ART_PATH_UNSAFE
  // 而不是形状错误 —— 作者写一条 `../x.png` 与写一个对象是两种错，提示要分开。
  if (shape.flat) return { entry, error: null };
  if (!isPlainObj(entry)) return { error: 'ART_BAD_SHAPE', detail: `${where} must be an object` };
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (shape.urls.includes(key)) {
      if (!isSafeAssetPath(value)) return { error: 'ART_PATH_UNSAFE', detail: `${where}.${key}: "${String(value)}" must be a relative path inside assets/` };
      out[key] = value;
      continue;
    }
    if (shape.strings.includes(key)) {
      if (typeof value !== 'string' || !value) return { error: 'ART_BAD_SHAPE', detail: `${where}.${key} must be a non-empty string` };
      out[key] = value;
      continue;
    }
    if (key === 'spine') {
      if (shape.spine === 'flat') {
        const parsed = parseArtSpine(value, `${where}.spine`);
        if (parsed.error) return parsed;
        out.spine = parsed.spine;
        continue;
      }
      if (!isPlainObj(value)) return { error: 'ART_BAD_SHAPE', detail: `${where}.spine must map sides to a spine object ({ front: {…}, back: {…} })` };
      const sides = {};
      for (const [side, obj] of Object.entries(value)) {
        if (side !== 'front' && side !== 'back') return { error: 'ART_UNKNOWN_FIELD', detail: `${where}.spine: "${side}" is not a side (front, back)` };
        const parsed = parseArtSpine(obj, `${where}.spine.${side}`);
        if (parsed.error) return parsed;
        sides[side] = parsed.spine;
      }
      if (Object.keys(sides).length) out.spine = sides;
      continue;
    }
    return {
      error: 'ART_UNKNOWN_FIELD',
      detail: `${where}: "${key}" is not a field of this art entry (${[...shape.urls, ...shape.strings, 'spine'].join(', ')})`,
    };
  }
  return { entry: out, error: null };
}

/**
 * Validate and normalise one pack's `pack.json`.
 * @param {any} raw parsed pack.json
 * @param {string} [dirName] the pack's directory name (authoritative when the manifest omits / contradicts `id`)
 * @returns {{ ok: true, pack: { id: string, name: string, version: string, author: string|null, license: string|null,
 *   description: string|null, gameVersion: string|null, content: string[], overrides: string[],
 *   voices: Record<string, Record<string, string[]>>, voiceLangs: Record<string, Record<string, Record<string, string[]>>>,
 *   bondIcons: Record<string, string>, itemIcons: Record<string, string>,
 *   art: Record<string, Record<string, object>>, support: string[],
 *   operators: Record<string, { powers: string[], bonds: string[] }> } }
 *   | { ok: false, error: string, detail: string }}
 */
export function normalizePackManifest(raw, dirName = '', opts = {}) {
  if (!isPlainObj(raw)) return fail('BAD_MANIFEST', 'pack.json must be a JSON object');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : dirName;
  if (!PACK_ID_RE.test(id)) return fail('BAD_PACK_ID', `"${id}" is not a valid pack id (letters, digits, _ and - only)`);
  if (dirName && typeof raw.id === 'string' && raw.id && raw.id !== dirName) {
    return fail('PACK_ID_MISMATCH', `pack.json id "${raw.id}" does not match its directory "${dirName}"`);
  }
  const content = Array.isArray(raw.content)
    ? [...new Set(raw.content.filter((f) => typeof f === 'string' && WORKSHOP_CONTENT_FILES.includes(f)))].sort()
    : [];
  // (EMPTY_PACK is checked after `voices` below: a pack whose whole contribution is a 助战 operator's voice lines has no
  // data file at all, and refusing it here would make the reserved voice pack impossible to write.)
  const overrides = Array.isArray(raw.overrides)
    ? [...new Set(raw.overrides.filter((o) => typeof o === 'string' && OVERRIDE_ENTRY_RE.test(o)))].sort()
    : [];
  const license = typeof raw.license === 'string' && raw.license ? raw.license : null;
  // A pack that SHIPS ITS OWN ART must say under what terms (`hasAssets` = it has an assets/ folder; the loader passes
  // it, since this function only sees the manifest). The repo ships no game assets, so a pack's art is the pack author's
  // to license — and the redistributor carries the risk, which is why the manifest has to name the licence rather than
  // leave it to a README nobody reads (docs/WORKSHOP.md §5).
  if (opts.hasAssets === true && !license) {
    return fail('ASSETS_NEED_LICENSE',
      'this pack has an assets/ folder, so pack.json must declare a license (e.g. "CC0-1.0", "CC-BY-4.0", or "see assets/LICENSE.txt")');
  }
  // Voice lines of a pack's own (or its 助战) operators — the RESERVED workshop half of the voice interface
  // (docs/WORKSHOP.md §1.4, docs/ASSETS.md "Voice lines"): `voices: { <charId>: { <slot>: ["<path inside assets/>", …] } }`.
  // The files live under the pack's assets/, so the licence gate above already applies to them, and the client reads
  // them from /workshop-assets/<pack>/<path> — the one route that serves pack media. Only the fixed slot vocabulary is
  // accepted, so a typo cannot silently produce a line that never plays.
  const voices = raw.voices === undefined ? {} : raw.voices;
  if (!isPlainObj(voices)) return fail('VOICE_BAD_SHAPE', 'voices must be an object: { "<charId>": { "<slot>": ["<path>"] } }');
  if (Object.keys(voices).length && opts.hasAssets !== true) {
    return fail('VOICE_NEEDS_ASSETS', 'a pack that declares voices must put the files in its assets/ folder (e.g. assets/voice/…)');
  }
  /**
   * Parse ONE `<charId> → <slot> → [path inside assets/]>` table. `voices` (the default dub) and every
   * `voiceLangs[<lang>]` carry exactly this shape and these rules, so they share one implementation — a rule that held
   * for one table but not the other would be a silent hole. `where` is how the author wrote the table, so a refusal
   * points at the exact place in pack.json (`voices["c"]["place"]`, `voiceLangs["jp"]["c"]["place"]`).
   * Paths are relative and inside assets/, with no traversal — the same rule the /workshop-assets route enforces
   * (that route refuses `.` and `..` segments, so a `.` here would only ever produce a URL that 404s).
   */
  const parseVoiceTable = (table, where) => {
    if (!isPlainObj(table)) return fail('VOICE_BAD_SHAPE', `${where} must map slots to file lists`);
    /** @type {Record<string, Record<string, string[]>>} */
    const out = {};
    for (const [charId, slots] of Object.entries(table)) {
      if (!/^[A-Za-z0-9_\-]{1,64}$/.test(charId)) return fail('VOICE_BAD_CHAR_ID', `${where}: "${charId}" is not a valid operator id`);
      if (!isPlainObj(slots)) return fail('VOICE_BAD_SHAPE', `${where}["${charId}"] must map slots to file lists`);
      const clean = {};
      for (const [slot, files] of Object.entries(slots)) {
        if (!VOICE_SLOTS.includes(slot)) {
          return fail('VOICE_SLOT_UNKNOWN', `${where}["${charId}"]["${slot}"] is not a voice slot (one of: ${VOICE_SLOTS.join(', ')})`);
        }
        const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f);
        if (!list.length) return fail('VOICE_EMPTY', `${where}["${charId}"]["${slot}"] names no file`);
        for (const f of list) {
          if (f.startsWith('/') || f.includes('\\') || f.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(f)) {
            return fail('VOICE_PATH_UNSAFE', `${where}["${charId}"]["${slot}"]: "${f}" must be a relative path inside assets/ (no absolute paths, no "..")`);
          }
        }
        clean[slot] = [...new Set(list)].sort();
      }
      if (Object.keys(clean).length) out[charId] = clean;
    }
    return { ok: true, table: out };
  };
  const parsedVoices = parseVoiceTable(voices, 'voices');
  if (!parsedVoices.ok) return parsedVoices;
  const voiceLines = parsedVoices.table;
  // 多语言配音：`voiceLangs: { "<lang>": { <charId>: { <slot>: ["<path>"] } } }` —— 一个语种一张表，与上面 `voices`
  // 同一个形状、同一套路径规则、同一个槽位词表。`voices` 是**默认配音**那一档（清单的 `audio.voiceLang`，
  // 见 docs/ASSETS.md），所以默认语种键写进 voiceLangs 会被拒（VOICE_LANG_DEFAULT）：同一批台词有两个写法的话，
  // 「客户端到底读哪一份」就成了作者猜不出来的事。播放侧不需要任何新通道 —— 加载时并进 `assets.audio.voiceLangs`
  // （mergeWorkshopVoices），客户端 public/js/audio.js voiceLinesFor 本来就在那张表里按语种取台词。
  const voiceLangs = raw.voiceLangs === undefined ? {} : raw.voiceLangs;
  if (!isPlainObj(voiceLangs)) {
    return fail('VOICE_LANG_BAD_SHAPE', 'voiceLangs must be an object: { "<lang>": { "<charId>": { "<slot>": ["<path>"] } } }');
  }
  if (Object.keys(voiceLangs).length && opts.hasAssets !== true) {
    return fail('VOICE_NEEDS_ASSETS', 'a pack that declares voices must put the files in its assets/ folder (e.g. assets/voice/…)');
  }
  /** @type {Record<string, Record<string, Record<string, string[]>>>} */
  const voiceLangLines = {};
  for (const [lang, table] of Object.entries(voiceLangs)) {
    if (!VOICE_LANGS.includes(lang)) {
      return fail('VOICE_LANG_UNKNOWN', `"${lang}" is not a dub (one of: ${VOICE_LANGS.join(', ')})`);
    }
    if (lang === DEFAULT_VOICE_LANG) {
      return fail('VOICE_LANG_DEFAULT', `"${lang}" is the default dub — declare its lines in "voices", not in "voiceLangs"`);
    }
    const parsed = parseVoiceTable(table, `voiceLangs["${lang}"]`);
    if (!parsed.ok) return parsed;
    if (!Object.keys(parsed.table).length) return fail('VOICE_LANG_EMPTY', `voiceLangs["${lang}"] declares no operator`);
    voiceLangLines[lang] = parsed.table;
  }
  // VOICE_LANGS order is the canonical one (same reason workshopVoiceLangIndex sorts): the table this function returns
  // goes straight into the merged manifest, whose bytes must not depend on how the author happened to write pack.json.
  const orderedLangLines = Object.fromEntries(VOICE_LANGS.filter((l) => voiceLangLines[l]).map((l) => [l, voiceLangLines[l]]));
  // 盟约图标（这个包自带的 art）：`bondIcons: { "<bondId>": "<path inside assets/>" }`。
  //
  // 为什么需要它：客户端按**盟约 id** 从 `data/assets.json` 的 `bonds` 取图标（public/js/assets.js bondIconUrl），
  // 而一个包没法往 `assets.json` 里加条目 —— 于是新增盟约在盟约条上只能是一个圆点。这里把这个口子开在
  // **pack.json 的一个字段**上（和一个包的语音是同一个做法），装载时叠加进 `assets.bonds`，URL 走同一条
  // /workshop-assets 路由。路径安全规则与语音逐字相同（相对 assets/、无穿越）。
  const bondIcons = raw.bondIcons === undefined ? {} : raw.bondIcons;
  if (!isPlainObj(bondIcons)) return fail('BOND_ICON_BAD_SHAPE', 'bondIcons must be an object: { "<bondId>": "<path inside assets/>" }');
  if (Object.keys(bondIcons).length && opts.hasAssets !== true) {
    return fail('BOND_ICON_NEEDS_ASSETS', 'a pack that declares bondIcons must put the image in its assets/ folder');
  }
  /** @type {Record<string, string>} */
  const bondIconFiles = {};
  for (const [bondId, file] of Object.entries(bondIcons)) {
    if (!/^[A-Za-z0-9_\-.:]{1,64}$/.test(bondId)) return fail('BOND_ICON_BAD_ID', `"${bondId}" is not a valid bond id`);
    if (typeof file !== 'string' || !file) return fail('BOND_ICON_BAD_SHAPE', `bondIcons["${bondId}"] must be a path inside assets/`);
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(file)) {
      return fail('BOND_ICON_PATH_UNSAFE', `"${file}" must be a relative path inside assets/ (no absolute paths, no "..")`);
    }
    bondIconFiles[bondId] = file;
  }
  // 装备/道具图标（这个包自带的 art）：`itemIcons: { "<iconId>": "<path inside assets/>" }`。
  //
  // 为什么需要它：客户端按**道具 id** 从 `data/assets.json` 的 `assets.items` 取图标（public/js/assets.js
  // itemIconUrl：先看 `item.iconId`、再看 `item.trapId`，然后查 `m.items[id]`），而一个包没法往 assets.json 里加
  // 条目 —— 于是包新增的装备在界面上没有图标。做法与 `bondIcons` 逐字相同：口子开在 pack.json 的一个字段上，
  // 装载时叠加进 `assets.items`（mergeWorkshopItemIcons），URL 走同一条 /workshop-assets 路由 —— 客户端零改动。
  // 键的字符集与其它 record id 同一套（RECORD_ID_RE），路径安全规则与语音/盟约图标逐字相同。
  const itemIcons = raw.itemIcons === undefined ? {} : raw.itemIcons;
  if (!isPlainObj(itemIcons)) return fail('ITEM_ICON_BAD_SHAPE', 'itemIcons must be an object: { "<itemId>": "<path inside assets/>" }');
  if (Object.keys(itemIcons).length && opts.hasAssets !== true) {
    return fail('ITEM_ICON_NEEDS_ASSETS', 'a pack that declares itemIcons must put the image in its assets/ folder');
  }
  /** @type {Record<string, string>} */
  const itemIconFiles = {};
  for (const [itemId, file] of Object.entries(itemIcons)) {
    if (!RECORD_ID_RE.test(itemId)) return fail('ITEM_ICON_BAD_ID', `"${itemId}" is not a valid item id`);
    if (typeof file !== 'string' || !file) return fail('ITEM_ICON_BAD_SHAPE', `itemIcons["${itemId}"] must be a path inside assets/`);
    if (file.startsWith('/') || file.includes('\\') || file.split('/').some((seg) => seg === '..' || seg === '.') || /^[A-Za-z]:/.test(file)) {
      return fail('ITEM_ICON_PATH_UNSAFE', `"${file}" must be a relative path inside assets/ (no absolute paths, no "..")`);
    }
    itemIconFiles[itemId] = file;
  }
  // 包自带的外观素材：`art: { chars | enemies | tokens: { "<id>": <该条目在 assets.json 里的形状的子集> } }`。
  //
  // 为什么需要它：客户端画一个单位时，模型与头像都从 `data/assets.json` 取 —— `public/js/assets.js spineEntry()` 读
  // `chars[id].spine.front/back`（嵌套）或 `tokens[id].spine` / `enemies[id].spine`（扁平），头像读
  // `chars[id].avatar/portrait`、`enemies[id].icon`。包没法往 assets.json 加条目，于是**新干员/新怪物只能画成
  // 一张菱形贴图**（shared/workshop.js chessLookIssues 会在启动日志里警告这件事）。这个字段把口子开在 pack.json 上：
  // 装载时叠加进 `assets.<表>`（mergeWorkshopArt），路径变成 /workshop-assets 的绝对 URL —— 客户端零改动
  // （validSpine 只要求 skel 是 `/` 开头的路径，包素材路由天然满足）。
  //
  // 两条**包改不了**的硬约束（由 vendor 里的 pixi-spine 决定，校验器会逐条查，见 tools/workshop-validate.mjs）：
  //   * `.atlas` 必须与 `.skel` **同目录同名** —— 加载器是从 skel 的路径推出 atlas 的，清单里的 `atlas` 字段我方代码
  //     只是用来做内存回收（assets.js forgetPendingSpine），写错不会报错，只会画不出来；
  //   * `.atlas` 里写的每一页 png 必须与它**同目录同名**。
  // 形状按表驱动（ART_TABLES）：哪几个字段是路径、spine 是嵌套（chars 的 front/back）还是扁平（enemies/tokens），
  // 都写在那一张表里，校验、索引与并表三处共用，不会各自漂移。
  const art = raw.art === undefined ? {} : raw.art;
  if (!isPlainObj(art)) return fail('ART_BAD_SHAPE', 'art must be an object: { chars|enemies|tokens: { "<id>": { … } } }');
  if (Object.keys(art).length && opts.hasAssets !== true) {
    return fail('ART_NEEDS_ASSETS', 'a pack that declares art must put the files in its assets/ folder (e.g. assets/art/…)');
  }
  /** @type {Record<string, Record<string, object>>} */
  const artEntries = {};
  for (const [table, entries] of Object.entries(art)) {
    const shape = ART_TABLES[table];
    if (!shape) return fail('ART_UNKNOWN_TABLE', `"${table}" is not an art table (one of: ${Object.keys(ART_TABLES).join(', ')})`);
    if (!isPlainObj(entries)) return fail('ART_BAD_SHAPE', `art.${table} must be an object: { "<id>": { … } }`);
    const clean = {};
    for (const [id, entry] of Object.entries(entries)) {
      if (!RECORD_ID_RE.test(id)) return fail('ART_BAD_ID', `art.${table}: "${id}" is not a valid id`);
      // 扁平表：条目本身就是路径（`assets.skills[key]` / `assets.prof.sub[key]` 的值就是路径字符串）
      if (shape.flat) {
        if (!isSafeAssetPath(entry)) {
          return fail('ART_PATH_UNSAFE', `art.${table}["${id}"]: "${String(entry)}" must be a relative path inside assets/`);
        }
        clean[id] = entry;
        continue;
      }
      const parsed = parseArtEntry(entry, `art.${table}["${id}"]`, shape);
      if (parsed.error) return fail(parsed.error, parsed.detail);
      if (Object.keys(parsed.entry).length) clean[id] = parsed.entry;
    }
    if (Object.keys(clean).length) artEntries[table] = clean;
  }
  // 助战卡池贡献 (docs/WORKSHOP.md §2): the operators of THIS pack that should be selectable as 助战. The tier is NOT
  // written here — it is derived from the pack's own chess record, exactly like every other derived field, so a tier can
  // never disagree with the record (a mismatch would silently disable the operator: shared/support.js isSupportChess
  // requires the id to sit under its own tier).
  const support = raw.support === undefined ? [] : raw.support;
  if (!Array.isArray(support)) {
    return fail('SUPPORT_BAD_SHAPE', 'support must be an array of operator ids this pack adds, e.g. ["chess_char_ws_my_op_a"]');
  }
  const supportIds = [];
  for (const id of support) {
    if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
      return fail('SUPPORT_BAD_ID', `"${String(id)}" is not a valid operator id`);
    }
    if (!supportIds.includes(id)) supportIds.push(id);
  }
  // 自选池贡献 (`pack.json.operators`, docs/WORKSHOP.md §1.2): the operators of THIS pack that should be **selectable
  // in the 自选 pool** (`data/backups.json` 的 `diy.ownedPool` / `diy.operators`) — the half that made a community
  // "new operator" mod a hand-patch instead of a pack.
  //
  // 形状是**对象**（不是数组）：每个干员要带它自己的盟约与该盟约的权能。而 `name` / `rarity` / `profession` /
  // `subProfessionId` **一律从同一个包的 `units[charId]` 派生**（`mergeWorkshopOperators`），清单里再写一遍就是
  // 两份会漂移的真相 —— `diy.operators` 那份今天是生成器产出的，包不该抄它。
  //
  // 这里只查**形状**与「同一个 id 只出现一次」；「有没有同名的 units 记录」「是不是 6★」「盟约存不存在」三条要读
  // 数据，它们失败要关闭，所以在加载期（`mergeWorkshopOperators`）判定并点名报告。
  const operators = raw.operators === undefined ? {} : raw.operators;
  if (!isPlainObj(operators)) {
    return fail('OPERATOR_BAD_SHAPE', 'operators must be an object: { "<charId>": { bonds: ["<bondId>"], powers: ["<powerId>"] } }');
  }
  /** @type {Record<string, { powers: string[], bonds: string[] }>} */
  const operatorDecls = {};
  for (const [charId, decl] of Object.entries(operators)) {
    if (!RECORD_ID_RE.test(charId)) return fail('OPERATOR_BAD_SHAPE', `operators: "${charId}" is not a valid operator id`);
    if (!isPlainObj(decl)) return fail('OPERATOR_BAD_SHAPE', `operators["${charId}"] must be an object: { bonds, powers }`);
    const parsed = { powers: [], bonds: [] };
    for (const field of OPERATOR_LIST_FIELDS) {
      const list = parseStringList(decl[field], `operators["${charId}"].${field}`);
      if (!list.ok) return fail('OPERATOR_BAD_SHAPE', list.detail);
      parsed[field] = list.list;
    }
    operatorDecls[charId] = parsed;
  }
  // 键序是**清单的字节**的一部分（`identifyPack` 把归一化后的清单哈希进去），所以按 id 排序，不随作者书写顺序变。
  const orderedOperators = Object.fromEntries(Object.keys(operatorDecls).sort().map((k) => [k, operatorDecls[k]]));
  // 试玩行为开关（行为层，不进记录）：`playtest: { "directToHand": ["<chessId>", …] }`。
  //
  // 为什么住在 pack.json 而不是 chess 记录里：覆盖模式下记录必须与官方**同形**（官方记录没有
  // `directToHand` 这个键，保存路径因此会在写补丁前把它摘掉），而「试玩时直接发到手上」是**行为层**的开关，
  // 不是「覆盖官方数据」这件事 —— 于是覆盖一条官方干员时它曾经静默失效。搬到这里之后，记录继续同形，
  // 开关照旧能用（见 docs/WORKSHOP.md §1.2）。
  //
  // 形状这一层只查「是不是对象、值是不是字符串数组」；「名单里的 id 真的属于这个包吗」要看包自己的
  // chess 记录与 `overrides`，那只有文件系统/加载器知道（`server/workshop.js` 与 `tools/workshop-pack.mjs`
  // 用同一个 `playtestUnknownIds` 判）。
  const playtest = raw.playtest === undefined ? {} : raw.playtest;
  if (!isPlainObj(playtest)) {
    return fail('PLAYTEST_BAD_SHAPE', 'playtest must be an object: { "directToHand": ["<chessId>", …] }');
  }
  /** @type {string[]} */
  let directToHand = [];
  if (playtest.directToHand !== undefined) {
    if (!Array.isArray(playtest.directToHand)) {
      return fail('PLAYTEST_BAD_SHAPE', 'playtest.directToHand must be an array of chess ids this pack ships (or declares in overrides)');
    }
    for (const id of playtest.directToHand) {
      if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) {
        return fail('PLAYTEST_BAD_SHAPE', `playtest.directToHand: "${String(id)}" is not a valid chess id`);
      }
      if (!directToHand.includes(id)) directToHand.push(id);
    }
    directToHand.sort();
  }
  // A pack may bring data files, voice lines (either table), 盟约图标, 装备图标, 外观素材, 助战声明, 自选池声明
  // — never none of them (docs/WORKSHOP.md §1.4). 这条检查必须放在**所有**贡献项都解析完之后：放在前面会出现
  // 「一个只带 `operators` 的包被判成空包」，而在它前面引用后面声明的变量则是 TDZ 报错。
  // `playtest` **不是**贡献项：它是行为开关，一个只带它的包仍然什么都没带来，照旧 EMPTY_PACK
  // （test/playtestDirectToHand.test.js 有断言钉住这一点）。
  if (!content.length && !Object.keys(voiceLines).length && !Object.keys(orderedLangLines).length
    && !Object.keys(bondIconFiles).length && !Object.keys(itemIconFiles).length && !Object.keys(artEntries).length
    && !Object.keys(orderedOperators).length) {
    return fail('EMPTY_PACK', `content must name at least one of: ${WORKSHOP_CONTENT_FILES.join(', ')} — or the pack must declare voices / voiceLangs / bondIcons / itemIcons / art / operators`);
  }
  // 版本声明（DESIGN §28.5）：`api` 是**模组 API** 的区间（钩子总线与 kit 契约），`game` 是**上游游戏版本**的区间，
  // 两者都用 shared/packs.js isVersionRange 的语法（`>=0.2.0`、`0.2.x`、`^0.2.0`、`~0.2.1`、`*`、`||`）。
  // `gameVersion` 保留一代作为 `game` 的别名：编辑器与现成的包都在写它，读的时候优先 `game`。
  const api = strField(raw.api, 60);
  if (api && !isVersionRange(api)) return fail('BAD_API_RANGE', `"api": "${api}" is not a version range (">=1 <2", "1.x" …)`);
  const game = strField(raw.game, 60) ?? strField(raw.gameVersion, 60);
  if (game && !isVersionRange(game)) return fail('BAD_GAME_RANGE', `"game": "${game}" is not a version range (">=0.2.0", "0.2.x" …)`);
  // 声明的层（DESIGN §28.1）：A 内容 / B 服务端逻辑 / C 客户端界面。写错了要拒，不能猜。
  const layer = raw.layer === undefined || raw.layer === null ? null : String(raw.layer).trim().toUpperCase();
  if (layer !== null && !MOD_LAYERS.includes(layer)) return fail('BAD_LAYER', `"layer": "${raw.layer}" is not one of ${MOD_LAYERS.join(' / ')}`);
  if (raw.combat !== undefined && typeof raw.combat !== 'boolean') return fail('BAD_COMBAT', '"combat" must be true or false (may this pack change a battle result?)');
  return {
    ok: true,
    pack: {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      version: typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0',
      author: typeof raw.author === 'string' && raw.author ? raw.author : null,
      license,
      hasAssets: opts.hasAssets === true,
      description: typeof raw.description === 'string' && raw.description ? raw.description : null,
      gameVersion: typeof raw.gameVersion === 'string' && raw.gameVersion ? raw.gameVersion : null,
      api,
      game,
      layer,
      combat: typeof raw.combat === 'boolean' ? raw.combat : null,
      content,
      overrides,
      voices: voiceLines,
      voiceLangs: orderedLangLines,
      bondIcons: bondIconFiles,
      itemIcons: itemIconFiles,
      art: artEntries,
      support: supportIds,
      operators: orderedOperators,
      playtest: { directToHand },
    },
  };
}

/**
 * `pack.json.playtest.directToHand` 里那些**不属于这个包**的 id（`PLAYTEST_UNKNOWN_CHESS` 的判罚依据）。
 *
 * 为什么要有这条：名单里的 id 只要加载器不认识，开关就是**静默失效** —— 作者在界面上勾了、试玩里却什么都没发生。
 * 静默无效正是这个缺口的老毛病，所以这里点名拒绝。合法的 id 只有两类：
 *   * 本包自己的 chess 记录 id（`ownChessIds`，非覆盖的工坊干员）；
 *   * 本包在 `overrides` 里声明过的官方 id（覆盖模式：记录写的是官方 id，加载器只认这条声明）。
 *
 * 形状（不是对象、值不是字符串数组）在 `normalizePackManifest` 就已经被拒了，这里只管成员资格。
 * 判罚只有这一份：加载器（`server/workshop.js`）、`tools/workshop-pack.mjs` 的 `readPackDir`
 * 与编辑器读包的地方都调它，所以三处不可能给出不同结论。
 *
 * @param {string[]} declared `pack.json.playtest.directToHand`（已归一化）
 * @param {string[]} overrides `pack.json.overrides`（`"<file>:<id>"` 列表）
 * @param {Iterable<string>} ownChessIds 本包 chess.json 自己的记录 id
 * @returns {string[]} 不认识的 id（保持声明顺序，去重）
 */
export function playtestUnknownIds(declared, overrides, ownChessIds) {
  const own = ownChessIds instanceof Set ? ownChessIds : new Set(Array.isArray(ownChessIds) ? ownChessIds : []);
  const declaredOverrides = new Set(Array.isArray(overrides) ? overrides : []);
  const out = [];
  for (const id of Array.isArray(declared) ? declared : []) {
    if (typeof id !== 'string' || !id) continue;
    if (own.has(id)) continue;
    if (declaredOverrides.has(`chess:${id}`)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Validate one content file of a pack: a `{ [id]: record }` map, every key a safe id, every value a JSON object, and —
 * when the record carries its own id field — that field equal to the key.
 *
 * `units`（新干员的干员记录）**另外**要过一遍「下游用得上吗」：见 `UNIT_REQUIRED_FIELDS` 的长注释 —— 我们只查那
 * 六个字段，其余一律照抄，不复制官方 schema。
 * @param {string} file data file basename, e.g. 'chess'
 * @param {any} json parsed file
 * @returns {{ ok: true, records: Record<string, object> } | { ok: false, error: string, detail: string }}
 */
export function normalizeContentFile(file, json) {
  if (!isPlainObj(json)) return fail('BAD_CONTENT', `${file}.json must be a JSON object of { id: record }`);
  const field = ID_FIELD_BY_FILE[file] || null;
  /** @type {Record<string, object>} */
  const records = {};
  for (const [id, rec] of Object.entries(json)) {
    if (!RECORD_ID_RE.test(id)) return fail('BAD_RECORD_ID', `${file}.json key "${id}" is not a valid id`);
    if (!isPlainObj(rec)) return fail('BAD_RECORD', `${file}.json["${id}"] must be a JSON object`);
    if (field && rec[field] !== undefined && rec[field] !== id) {
      return fail('ID_MISMATCH', `${file}.json["${id}"].${field} is "${rec[field]}" — it must equal the key`);
    }
    if (file === 'units') {
      for (const need of UNIT_REQUIRED_FIELDS) {
        if (need.ok(rec[need.key])) continue;
        return fail(need.code, `units.json["${id}"].${need.key} ${need.detail}`);
      }
    }
    records[id] = rec;
  }
  if (!Object.keys(records).length) return fail('EMPTY_CONTENT', `${file}.json has no records`);
  return { ok: true, records };
}

/**
 * The voice lines every pack contributes, keyed exactly like the manifest the client looks them up in:
 * `{ <charId>: { <slot>: [url, …] } }` (docs/ASSETS.md "Voice lines").
 *
 * The URLs point into the pack media route (`WORKSHOP_MEDIA_PREFIX`), so the client needs no new channel: the overlay
 * merges this map into `assets.audio.voice` and the game server serves `/data/assets.json` merged, which is the object
 * public/js/audio.js already reads (`installAudio({ getManifest: () => data.get('assets') })`).
 *
 * Every path segment is percent-encoded: a pack filename may legitimately hold a `#`, a space or a `+`, and the route
 * decodes the path before it resolves it (`/workshop-assets/<pack>/voice/a%23b.mp3`).
 *
 * @param {Array<{ id: string, voices?: Record<string, Record<string, string[]>>, voiceLangs?: Record<string, Record<string, Record<string, string[]>>> }>} packs loaded packs (server/workshop.js)
 * @param {{ prefix?: string, lang?: string|null }} [opts] `lang` selects a dub's table (`voiceLangs[lang]`); the default
 *   (null) is the pack's default-dub table `voices`.
 * @returns {Record<string, Record<string, string[]>>}
 */
export function workshopVoiceIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX, lang = null } = {}) {
  /** @type {Record<string, Record<string, string[]>>} */
  const out = {};
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id);
  // sorted by pack id: the merged line list must not depend on the order the filesystem handed the packs over
  for (const pack of [...list].sort(byPackId)) {
    const table = lang === null
      ? (isPlainObj(pack.voices) ? pack.voices : null)
      : (isPlainObj(pack.voiceLangs) && isPlainObj(pack.voiceLangs[lang]) ? pack.voiceLangs[lang] : null);
    if (!table) continue;
    for (const [charId, slots] of Object.entries(table)) {
      if (!isPlainObj(slots)) continue;
      for (const [slot, files] of Object.entries(slots)) {
        if (!Array.isArray(files) || !files.length) continue;
        const bySlot = (out[charId] ||= {});
        const urls = (bySlot[slot] ||= []);
        for (const f of files) {
          if (typeof f !== 'string' || !f) continue;
          urls.push(prefix + pack.id + '/' + f.split('/').map(encodeURIComponent).join('/'));
        }
      }
    }
  }
  return out;
}

/**
 * Every NON-default dub the packs declare, one index each: `{ <lang>: <workshopVoiceIndex shape> }`.
 *
 * The default dub's table is `voices` itself, so it is not repeated here — `normalizePackManifest` refuses a
 * `voiceLangs[<default>]` outright (VOICE_LANG_DEFAULT). A language no pack declares is simply absent, so the overlay
 * never writes an empty `voiceLangs` into a manifest that had none.
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 * @returns {Record<string, Record<string, Record<string, string[]>>>}
 */
export function workshopVoiceLangIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, Record<string, Record<string, string[]>>>} */
  const out = {};
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!pack || !isPlainObj(pack.voiceLangs)) continue;
    for (const lang of Object.keys(pack.voiceLangs)) {
      if (out[lang] || !VOICE_LANGS.includes(lang) || lang === DEFAULT_VOICE_LANG) continue;
      const index = workshopVoiceIndex(packs, { prefix, lang });
      if (Object.keys(index).length) out[lang] = index;
    }
  }
  // VOICE_LANGS order decides the key order: this object ends up in the merged manifest, and that file must not change
  // with the order the packs happened to load in.
  return Object.fromEntries(VOICE_LANGS.filter((l) => out[l]).map((l) => [l, out[l]]));
}

/**
 * The ONE arbitration order of the overlay (DESIGN §28.3): pack ids are slugs, so a plain code-unit compare is a stable,
 * locale-independent order, and "the pack with the smaller id wins" is decided by this comparator on **every** face —
 * data records, kit ids, icons, item icons and art. Exported because the kit loader (server/workshop.js) must sort by
 * the same rule; two orderings would be two contracts, and the loser of a collision would depend on which one ran.
 */
export const byPackId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 「试玩时直接发到手上」名单的**声明侧**：把所有包的 `pack.json.playtest.directToHand` 汇成一份名单，并裁掉撞车的。
 *
 * 沿用 §1.2 的**谁赢**规则（DESIGN §28.3）：两个包声明同一个 id 时，包 id 字典序最小者赢，输的一方拿到一条
 * **点名**报告（`definedBy` 是赢家的包 id）。与其它面一样，结果只取决于包 id —— 先把包按 `byPackId` 排序再处理，
 * 所以与「目录是按什么顺序扫描到的」无关。
 *
 * 这只是名单的**一半**：另一半是记录里自带 `directToHand: true` 的工坊件（非覆盖的包，向后兼容）。
 * 两半的并集在引擎侧算（`server/match/match/phases.js` 的 `directToHandIds`）—— 正式服务器一个都不发，
 * 因为那里 `SP_PLAYTEST` 不是 `1`。
 *
 * @param {Array<{ id: string, playtest?: { directToHand?: string[] } }>} packs
 * @returns {{ ids: string[], errors: Array<{ pack: string, id: string, code: string, definedBy: string, reason: string }> }}
 */
export function workshopPlaytestIndex(packs) {
  /** @type {string[]} */
  const ids = [];
  const owner = new Map();
  const errors = [];
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    const declared = isPlainObj(pack.playtest) && Array.isArray(pack.playtest.directToHand) ? pack.playtest.directToHand : [];
    for (const id of declared) {
      if (typeof id !== 'string' || !id) continue;
      const holder = owner.get(id);
      if (holder) {
        if (holder === pack.id) continue;
        errors.push({
          pack: pack.id, id, code: 'PLAYTEST_ID_COLLISION', definedBy: holder,
          reason: `"${id}" is already declared by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Remove it from this pack, or rename the record; an "overrides" entry does not win against another pack`,
        });
        continue;
      }
      owner.set(id, pack.id);
      ids.push(id);
    }
  }
  return { ids, errors };
}

/**
 * Keys of a record that an override REPLACES wholesale instead of merging field by field (DESIGN §28.3, owner's
 * request of 2026-10-09). Two classes, one reason each:
 *
 *   * **behaviour / structure** — `skill`, `skills`, `talents`, `trait`, `traitBase`, `traitOverride`, `modules`,
 *     `rangeGrid`, `attackRangeGrid`, `assets`, `diy`, `bonds`: these are read as whole units by the sim and the
 *     loadout layer (`shared/loadoutRecord.js` resolveRecordLoadout / loadoutRecord, `server/sim/simdata.js`).
 *     Half-merging e.g. a `skill` (a new index with the old blackboard) would create a record nobody wrote and no
 *     validator describes; replacing is the only honest reading of "this pack ships its own skill".
 *   * **arrays** — replaced by definition, a field-wise array merge has no meaning here.
 *
 * Everything else (numbers, strings, booleans and the plain objects that hold them, e.g. `stats`, `assets`' sibling
 * numeric maps) is merged field by field, recursively, so an override that writes ONE number keeps every other field of
 * the official record. That is the whole point: before this, a one-key override silently reduced a 44-field operator to
 * two fields, and `applyWorkshop` reported no error at all.
 */
export const OVERRIDE_REPLACE_KEYS = Object.freeze([
  'skill', 'skills', 'trait', 'traitBase', 'traitOverride', 'modules',
  'rangeGrid', 'attackRangeGrid', 'assets', 'diy', 'bonds',
]);

/**
 * Lists whose entries carry a **stable identity key**: merged entry by entry on that key instead of wholesale, so an
 * author's partial edit cannot erase data they never wrote.
 *
 * Why this exists (0.2.2's potential annotations): a record in `data/chess.json` carries `potDown`, and a talent carries
 * `potMin` + `potBelow` — the chain that changes that talent below a potential rank (`shared/potential.js`). A record
 * the editor derives deliberately carries **none** of them (that is the engine's convention; `stripPotential` is "what a
 * record built at one rank looks like"). So replacing `talents` wholesale dropped the official's whole potential chain
 * the moment an author touched one talent — while `potDown` survived only because the patch never mentioned it. Merging
 * by `index` keeps the chain: the author's fields win, everything they did not write stays.
 *
 * The key is a property of the **list**, not of the entry shape, and it is not always `index`:
 *
 *   * `talents` / `talentsBase` — a talent entry is keyed by `index` (sparse: 0, 1, 3).
 *   * `talentChanges` — the module-internal talent rewrites, keyed by `talentIndex` (the `name` of the field says it).
 *     It sits INSIDE an entry of `modules`, which is itself replaced wholesale; the key list still applies, because
 *     `mergeRecord` recurses into the entries it pairs up. Without it the same silent loss happened one level deeper:
 *     a record opened as an override template comes back without `potMin`/`potBelow`, `modules` is replaced wholesale,
 *     and the official's chained module talent is gone (see `test/overridePotential.test.js`).
 *
 * Deliberately narrow: only lists that HAVE such a key. `bonds` / `immunities` / `rangeGrid` / `modules` itself still
 * replace wholesale (see the note above `OVERRIDE_REPLACE_KEYS`): a field-wise merge of a bare list would invent a
 * record nobody wrote, and `modules` is an ordered list the loadout screen reads as a whole.
 */
export const OVERRIDE_KEYED_LISTS = Object.freeze({ talents: 'index', talentsBase: 'index', talentChanges: 'talentIndex' });

/**
 * Merge one override record onto the record it replaces: field by field, with `OVERRIDE_REPLACE_KEYS` and arrays taken
 * wholesale (`OVERRIDE_KEYED_LISTS` excepted — those merge on their identity key). The input objects are never mutated
 * (the caller may keep the official data frozen).
 * @param {object} base the record being overridden (official, or a record an earlier pack contributed)
 * @param {object} patch the pack's record
 * @returns {object} a new record
 */
export function mergeRecord(base, patch) {
  if (!isPlainObj(base) || !isPlainObj(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const idKey = OVERRIDE_KEYED_LISTS[key];
    if (idKey && Array.isArray(value) && Array.isArray(base[key])) {
      out[key] = mergeKeyedList(base[key], value, idKey);
      continue;
    }
    if (OVERRIDE_REPLACE_KEYS.includes(key) || Array.isArray(value)) { out[key] = value; continue; }
    out[key] = isPlainObj(value) && isPlainObj(base[key]) ? mergeRecord(base[key], value) : value;
  }
  return out;
}

/**
 * Merge a list whose entries carry an identity key (`OVERRIDE_KEYED_LISTS`) onto the base list: entries pair up by that
 * key and merge field by field, unmatched base entries stay where they are, unmatched patch entries are appended.
 *
 * Order and the base's own order are preserved (a `talents` index is sparse — 0, 1, 3 — so array position is not the
 * key). An entry without a usable key is appended rather than guessed at: that is a talent the author added.
 *
 * **A key that repeats is not an identity.** `talentChanges` uses `-1` for "a hidden module talent", and an official
 * module may carry several of those, so the same key can address more than one entry. When either side has a duplicate
 * key the whole list falls back to the behaviour every other list gets (replace wholesale): pairing two of them would
 * drop an entry, and appending the ambiguous ones would reorder a list the loadout screen reads positionally. Merging
 * is for a list that really is keyed; when the data says otherwise, honesty beats cleverness.
 * @param {unknown[]} baseList @param {unknown[]} patchList @param {string} idKey
 * @returns {unknown[]}
 */
function mergeKeyedList(baseList, patchList, idKey) {
  const at = new Map();
  const dup = (list) => {
    const seen = new Set();
    for (const entry of list) {
      if (!isPlainObj(entry) || !Number.isInteger(entry[idKey])) continue;
      if (seen.has(entry[idKey])) return true;
      seen.add(entry[idKey]);
    }
    return false;
  };
  if (dup(baseList) || dup(patchList)) return patchList;
  for (const [i, entry] of baseList.entries()) {
    if (isPlainObj(entry) && Number.isInteger(entry[idKey])) at.set(entry[idKey], i);
  }
  const out = baseList.map((e) => e);
  const added = [];
  for (const entry of patchList) {
    const i = isPlainObj(entry) && Number.isInteger(entry[idKey]) ? at.get(entry[idKey]) : undefined;
    if (i === undefined) { added.push(entry); continue; }
    out[i] = mergeRecord(baseList[i], entry);
  }
  return [...out, ...added];
}

/**
 * The keys of `patch` that the record it overrides does not have (DESIGN §28.3, "closed world"): a declared override
 * may only speak about fields that exist, because today any well-formed nonsense is accepted silently and the author
 * gets a record that is quietly not what they wrote. `null` when `base` is not an object (nothing to compare against).
 * @param {object} base @param {object} patch
 * @returns {string[]|null}
 */
export function unknownOverrideKeys(base, patch) {
  if (!isPlainObj(base) || !isPlainObj(patch)) return null;
  return Object.keys(patch).filter((k) => !Object.hasOwn(base, k));
}

/**
 * Resolve every pack's 助战 declaration (`pack.json.support`) into the pool entries it asks for, plus the reasons a
 * declaration is refused (docs/WORKSHOP.md §2).
 *
 * ONE rule, two callers: the overlay (`mergeWorkshopSupport`, which actually publishes them) and
 * `tools/workshop-validate.mjs` (which reports them to the author). Two restrictions, both deliberate:
 *   * only an operator THIS pack adds may enter the pool — a pack must not change which OFFICIAL operators are
 *     available as 助战 (that is a rules decision, and the pool belongs to the install);
 *   * the TIER is derived from the record, never written in the manifest, so it cannot disagree with it — a mismatch
 *     would silently disable the operator, because shared/support.js `isSupportChess` requires an id to sit under the
 *     tier its record declares.
 *
 * @param {Readonly<Record<string, any>>} data merged game data (the tier is read from the MERGED chess record)
 * @param {Array<{ id: string, support?: string[], files?: Record<string, Record<string, object>> }>} packs
 * @returns {{ entries: Array<{ pack: string, id: string, tier: number }>, errors: Array<{ pack: string, id: string, code: string, reason: string }> }}
 */
export function workshopSupportEntries(data, packs) {
  const entries = [];
  const errors = [];
  const chess = isPlainObj(data) && isPlainObj(data.chess) ? data.chess : {};
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId)) {
    const own = isPlainObj(pack.files) && isPlainObj(pack.files.chess) ? pack.files.chess : {};
    for (const id of Array.isArray(pack.support) ? pack.support : []) {
      if (!Object.hasOwn(own, id)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_FOREIGN_OPERATOR',
          reason: `"${id}" is not an operator this pack adds — only a pack's OWN operators may enter the 助战 pool`,
        });
        continue;
      }
      const rec = isPlainObj(chess[id]) ? chess[id] : own[id];
      const tier = rec ? rec.tier : null;
      if (!isSupportTier(tier)) {
        errors.push({
          pack: pack.id, id, code: 'SUPPORT_TIER_UNKNOWN',
          reason: `"${id}" has no integer tier 1–6 (got ${JSON.stringify(tier)}), so it can never be a 助战`,
        });
        continue;
      }
      entries.push({ pack: pack.id, id, tier });
    }
  }
  return { entries, errors };
}

/**
 * Publish the 助战 pool entries the packs ask for into `data/support.json` (docs/WORKSHOP.md §2) — this is what makes a
 * distributed pack SELF-CONTAINED: without it, a player who installs a pack that adds a 助战 operator would also have to
 * hand-edit `data/support.json` before the operator could be picked.
 *
 * The installer keeps the last word: `"workshop": false` in `data/support.json` turns every pack contribution off.
 */
function mergeWorkshopSupport(data, packs, report) {
  const { entries, errors } = workshopSupportEntries(data, packs);
  for (const e of errors) report.errors.push({ pack: e.pack, file: 'support', id: e.id, code: e.code, reason: e.reason });
  if (!entries.length) return;
  const support = isPlainObj(data.support) ? data.support : null;
  if (!support) {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.pack)) continue;
      seen.add(e.pack);
      report.errors.push({
        pack: e.pack, file: 'support', id: e.id, code: 'MANIFEST_MISSING',
        reason: 'this pack declares 助战 operators, but data/support.json is missing — 助战 is off for this install',
      });
    }
    return;
  }
  if (support.workshop === false) { report.supportOff = true; return; }
  const pool = { ...(isPlainObj(support.pool) ? support.pool : {}) };
  /** @type {Record<string, string[]>} */
  const added = {};
  for (const { pack, id, tier } of entries) {
    const key = String(tier);
    const list = Array.isArray(pool[key]) ? pool[key].slice() : [];
    if (!list.includes(id)) list.push(id);
    list.sort();
    pool[key] = list;
    (added[pack] ||= []).push(id);
  }
  data.support = { ...support, pool };
  report.support = added;
}

/**
 * 内容文件的记录**落在哪个容器**里 —— 只对本仓库的**真实数据布局**与文件名不一致的那一个文件开口子。
 *
 * `units.json` 是唯一一个：「新增一个干员的干员记录」在 `data/` 里**没有顶层 `units.json`**，那条记录住在
 * `data/backups.json` 的 `units[charId]`（`server/sim/simdata.js:541`、`shared/standIn.js:36`、客户端
 * `data.get('backups').units` 都只读这一个位置）。所以 `content: ["units"]` 的 `units.json` 会被并进
 * `data.backups.units` —— 这也正是合同 §1.1 写的那句「落盘：`applyWorkshop` 里写进 `data.backups.units[id]`」。
 *
 * 其它文件一律同名：`chess.json` → `data.chess`，`items.json` → `data.items`，依此类推（不在这里出现）。
 */
const OVERLAY_TARGET_BY_FILE = Object.freeze({ units: ['backups', 'units'] });

/**
 * 把一组记录并进 `out` 上由 `OVERLAY_TARGET_BY_FILE` 指定的那一层。
 *
 * 非嵌套的文件（绝大多数）：就是 `out[file]` 的一份浅复制，写完挂回去。
 * 嵌套的文件（今天的 `units` → `backups.units`）：路径上的每一层各浅复制一次，**只复制这条路径**，
 * 所以 `backups` 的同层兄弟（`diy` / `tokens`）原样留着，`data/*.json` 也一个字节都不动。
 *
 * @param {Record<string, any>} out 合并中的顶层数据
 * @param {Record<string, any>} base 加载出来的官方数据（`overrides` 的「官方那条」从这里取）
 * @param {string} file 内容文件基名
 * @param {Record<string, object>} records 归一化过的记录
 * @param {(id: string, rec: object, prior: Record<string, object>) => 'added'|'overridden'} mergeOne
 *   把一条记录并进 `prior`（调用方负责判定与报错）；返回它是新增还是覆盖。
 * @returns {Record<string, number>} `{ added, overridden }`
 */
function overlayContentFile(out, base, file, records, mergeOne) {
  const path = OVERLAY_TARGET_BY_FILE[file] || [file];
  /** @type {Array<{ owner: Record<string, any>, key: string, value: Record<string, any> }>} */
  const chain = [];
  let cur = out;
  for (const seg of path.slice(0, -1)) {
    const inner = isPlainObj(cur[seg]) ? { ...cur[seg] } : {};
    chain.push({ owner: cur, key: seg, value: inner });
    cur = inner;
  }
  const leaf = path[path.length - 1];
  const prior = isPlainObj(cur[leaf]) ? cur[leaf] : {};
  const merged = { ...prior };
  let added = 0;
  let overridden = 0;
  for (const [id, rec] of Object.entries(records || {})) {
    const outcome = mergeOne(id, rec, prior);
    if (!outcome) continue;
    merged[id] = outcome.record;
    if (outcome.existed) overridden++; else added++;
  }
  cur[leaf] = merged;
  for (let i = chain.length - 1; i >= 0; i--) chain[i].owner[chain[i].key] = chain[i].value;
  return { added, overridden };
}

/** `base` 上这条记录所在的容器（`overrides` 的「官方那条」要按落盘位置取，不是按内容文件名取）。 */
function baseContainerFor(base, file) {
  const path = OVERLAY_TARGET_BY_FILE[file] || [file];
  let cur = isPlainObj(base) ? base : null;
  for (const seg of path) {
    if (!cur || !isPlainObj(cur[seg])) return null;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Apply every pack's content on top of the official data and return a NEW top-level object (the input is never
 * mutated; the caller freezes the result). Official ids are only replaced when the pack declared them in `overrides`;
 * a collision that was not declared is a reported error and the record already in place is kept.
 *
 * The record already in place is not always an OFFICIAL one: packs are merged in `byPackId` order (DESIGN §28.3 — the
 * order is the rule, not the caller's array order), so a later pack claiming an earlier pack's new id collides with
 * that pack. Such an error says which pack holds the id (`definedBy`, and in the text); it used to say "already exists
 * in the official data" for both cases, which sent the author looking for a record that is not in `data/`.
 *
 * @param {Readonly<Record<string, any>>} base the loaded official data (server/data.js)
 * @param {Array<{ id: string, name?: string, overrides?: string[], files: Record<string, Record<string, object>> }>} packs
 * @returns {{ data: Record<string, any>, report: { packs: object[], added: Record<string, string[]>, overridden: Record<string, string[]>, errors: Array<{ pack: string, file: string, id: string, code: string, definedBy?: string, reason: string }> } }}
 */
export function applyWorkshop(base, packs) {
  const out = { ...(isPlainObj(base) ? base : {}) };
  const report = { packs: [], added: {}, overridden: {}, errors: [] };
  const push = (bag, file, id) => { (bag[file] ||= []).push(id); };
  /** 工坊新增/覆盖的每一条干员记录（供 `chessLookIssues` 事后判断它有没有模型）。 */
  const looked = [];
  /** 同上，怪物记录（`enemies`）：包自带怪物模型这条路本来没有任何启动保护，见 `enemyLookIssues`。 */
  const lookedEnemies = [];

  /** `"<file>:<id>"` → the pack id that put that record into `out` (a pack-vs-pack collision is attributed with it). */
  const contributors = new Map();

  // THE ordering rule (DESIGN §28.3): the smaller pack id wins every collision, so the merge never depends on the
  // order the caller happened to hand the packs over in. Sorting a copy keeps the caller's array untouched.
  for (const pack of (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p === 'object' && p.id).sort(byPackId)) {
    const declared = new Set(Array.isArray(pack.overrides) ? pack.overrides : []);
    const entry = { id: pack.id, name: pack.name || pack.id, files: {} };
    for (const [file, records] of Object.entries(pack.files || {})) {
      // 落盘位置由 `overlayContentFile` 决定（`units` 并进 `data.backups.units`，其余文件就是 `out[file]`）。
      // `priorMap` 是 **官方数据 + 这个包之前已经并进去的每一个包**（变量曾经叫 `official`，把它当成「只有官方」
      // 正是那条把作者引到 `data/` 去找一条其实属于另一个包的记录的错误文案）。
      const { added, overridden } = overlayContentFile(out, base, file, records, (id, rec, priorMap) => {
        const key = `${file}:${id}`;
        const exists = Object.hasOwn(priorMap, id);
        const holder = contributors.get(key);
        // The owner's refinement (2026-10-09, DESIGN §28.3): when another PACK already contributed this record, pack id
        // order decides the winner — the later pack loses even if it declared `"<file>:<id>"` in `overrides`, because a
        // declaration is the authorisation to replace OFFICIAL data, not a licence to overwrite another pack. Two packs
        // adding the same NEW id is the same rule seen from the other side: the id is refused and the holder is named.
        if (holder) {
          report.errors.push({
            pack: pack.id, file, id, code: 'PACK_ID_COLLISION', definedBy: holder,
            reason: `"${id}" is already contributed by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Rename this record, or let "${holder}" drop it; an "overrides" entry does not win against another pack`,
          });
          return null;
        }
        if (exists && !declared.has(key)) {
          report.errors.push({
            pack: pack.id, file, id, code: 'OFFICIAL_ID_COLLISION', definedBy: 'official',
            reason: `"${id}" already exists in the official data — add "${file}:${id}" to pack.json overrides to replace it`,
          });
          return null;
        }
        // A declared override is a FIELD-LEVEL patch, not a replacement (DESIGN §28.3): writing one number must keep
        // every other field of the record it overrides. And it may only speak about fields that exist ("closed world").
        if (exists) {
          const official = baseContainerFor(base, file)?.[id] ?? priorMap[id];
          const unknown = unknownOverrideKeys(official, rec);
          if (unknown && unknown.length) {
            report.errors.push({
              pack: pack.id, file, id, code: 'UNKNOWN_OVERRIDE_FIELD', definedBy: 'official',
              reason: `the override of "${id}" names ${unknown.map((k) => `"${k}"`).join(', ')}, which the record does not have — an override may only change fields that exist (add the record under a new id to invent one)`,
            });
            return null;
          }
        }
        contributors.set(key, pack.id);
        if (file === 'chess') looked.push({ pack: pack.id, id, rec });
        if (file === 'enemies') lookedEnemies.push({ pack: pack.id, id, rec });
        if (exists) push(report.overridden, file, id); else push(report.added, file, id);
        return { record: exists ? mergeRecord(priorMap[id], rec) : rec, existed: exists };
      });
      entry.files[file] = { added, overridden };
    }
    report.packs.push(entry);
  }
  linkWorkshopStages(out, report);
  mergeWorkshopVoices(out, packs, report);
  mergeWorkshopBondIcons(out, packs, report);
  mergeWorkshopItemIcons(out, packs, report);
  // 必须在 chessLookIssues 之前：那条检查读的是**合并后**的 assets.chars，包自带模型到位之后
  // 「这个干员没有模型（会画成贴纸）」的警告就该消失（反过来放在后面，日志会一直报一条已经解决的问题）。
  mergeWorkshopArt(out, packs, report);
  // 扁平的那两张图标表（`assets.skills` / `assets.prof.sub`）—— 与上一条同一个理由放在 looks 之前，
  // 而且必须在 mergeWorkshopOperators 之前：干员进池时读的 `units` 记录已经由内容文件那一层并好了，
  // 但它的**分支图标**要靠这一条（`prof.sub[subProfessionId]`），顺序反了自选界面就是一个没有分支图的格子。
  mergeWorkshopFlatArt(out, packs, report);
  mergeWorkshopSupport(out, packs, report);
  // 自选池（`diy.ownedPool` / `diy.operators`）：读 `data.backups.units` 里那条已经合并好的记录，
  // 所以必须排在内容文件那一层之后 —— 它在这个函数里是最末一批，天然满足。
  mergeWorkshopOperators(out, packs, report);
  // 试玩开关（`pack.json.playtest`）不并进任何数据文件 —— 它是**行为层**的声明，引擎只在试玩服务器里读它
  // （`SP_PLAYTEST=1`）。但两个包撞同一个 id 这件事必须与其它面一样被点名报告，否则输的一方会在
  // 「我明明勾了」和「试玩里没有」之间反复，而日志一句话都不说。
  for (const e of workshopPlaytestIndex(packs).errors) report.errors.push({ pack: e.pack, file: 'playtest', id: e.id, code: e.code, definedBy: e.definedBy, reason: e.reason });
  report.looks = [...chessLookIssues(out, looked), ...enemyLookIssues(out, lookedEnemies)];
  for (const list of Object.values(report.added)) list.sort();
  for (const list of Object.values(report.overridden)) list.sort();
  return { data: out, report };
}

/**
 * 工坊干员的**外观能不能真的渲染成模型**：`assets.spine`（或 `charId`）必须是本机素材清单 `assets.chars` 里的键。
 *
 * 为什么单独查这一条：查不到时游戏**不会报错** —— `assets.spineEntry()` 返回 null，单位就画成一张头像菱形贴图，
 * 于是作者只会觉得「模型没加载出来」。这个仓库不携带干员美术，但**包可以自带**（`pack.json.art.chars` 里的
 * `spine`，0.8.0 起）：所以这条检查读的是**合并后**的 `assets.chars` —— 包把自己的模型接上去之后，警告自然消失
 * （applyWorkshop 里必须在写 `report.looks` 之前先合并 art，否则日志会一直报一条已经解决的问题）。
 * 没带模型时，「复用已装好的 spine id」仍是唯一的路；手写包与编辑器写出来的包在这一层同样能被发现。
 *
 * 只查干员、不查怪物：怪物那条在 `enemyLookIssues`（同一个 `report.looks`，条目上带 `kind: 'enemy'`）。
 *
 * 没有清单（素材流程没跑）时不判断：宁可不说，也不要乱说。
 *
 * @param {Readonly<Record<string, any>>} data 合并后的数据
 * @param {Array<{ pack: string, id: string, rec: object }>} looked 工坊贡献的干员记录
 * @returns {Array<{ pack: string, id: string, spine: string|null, code: string, reason: string }>}
 */
function chessLookIssues(data, looked) {
  const chars = isPlainObj(data.assets) && isPlainObj(data.assets.chars) ? data.assets.chars : null;
  if (!chars || !Object.keys(chars).length) return [];
  const out = [];
  for (const { pack, id, rec } of looked) {
    const spine = isPlainObj(rec) && isPlainObj(rec.assets) && typeof rec.assets.spine === 'string' ? rec.assets.spine
      : (isPlainObj(rec) && typeof rec.charId === 'string' ? rec.charId : null);
    if (spine && Object.hasOwn(chars, spine)) continue;
    out.push({
      pack, id, spine, code: spine ? 'MODEL_UNKNOWN' : 'MODEL_MISSING',
      reason: spine
        ? `${id}: assets.spine "${spine}" is not in this install's model list (data/assets.json chars) — it renders as a flat portrait, not a model`
        : `${id}: no assets.spine — it renders as a flat portrait, not a model. Reuse an installed spine id (an existing operator's) instead`,
    });
  }
  return out;
}

/**
 * 包自带的**怪物**模型有没有着落 —— `chessLookIssues` 的怪物版（同一条 `report.looks`，条目带 `kind: 'enemy'`）。
 *
 * 为什么要有它：干员那条检查只由 `chess` 记录填（`looked`），而怪物走 `enemies.json` —— 包新增的怪物如果把 `spine`
 * 写成一个本机没有的模型 id，客户端**同样一条日志都不打**：`assets.spineEntry()` 返回 null，那只怪物画成一张图标
 * 贴图。判定链与客户端逐字一致（`server/sim/simdata.js` 取 `rec.spine ?? key`；`public/js/assets.js spineEntry` 读
 * `enemies[key].spine`，条目里的 `spineAliasOf` 指向另一个模型），所以别名链要跟着走（官方有 8 个敌人是这样）。
 *
 * `assets.json` 里没有 `enemies` 表（没跑过素材管线）时不判断：宁可不说，也不要乱说。
 * @param {Readonly<Record<string, any>>} data 合并后的数据
 * @param {Array<{ pack: string, id: string, rec: object }>} looked 工坊贡献的怪物记录
 * @returns {Array<{ pack: string, id: string, spine: string, kind: string, code: string, reason: string }>}
 */
function enemyLookIssues(data, looked) {
  if (!looked.length) return [];
  const enemies = isPlainObj(data.assets) && isPlainObj(data.assets.enemies) ? data.assets.enemies : null;
  if (!enemies || !Object.keys(enemies).length) return [];
  const out = [];
  for (const { pack, id, rec } of looked) {
    const want = isPlainObj(rec) && typeof rec.spine === 'string' && rec.spine ? rec.spine : id;
    let cur = want;
    let ok = false;
    // 跟着 spineAliasOf 走：别名链是有向的、官方数据里不会成环，但这里仍然限深，坏数据不能把启动卡住
    for (let hop = 0; hop < 8 && cur; hop++) {
      const entry = enemies[cur];
      if (!isPlainObj(entry)) break;
      if (isPlainObj(entry.spine)) { ok = true; break; }
      cur = typeof entry.spineAliasOf === 'string' && entry.spineAliasOf ? entry.spineAliasOf : '';
    }
    if (ok) continue;
    const known = Object.hasOwn(enemies, want);
    out.push({
      pack, id, spine: want, kind: 'enemy', code: known ? 'MODEL_MISSING' : 'MODEL_UNKNOWN',
      reason: known
        ? `${id}: assets.enemies "${want}" carries no model of its own (no spine, and no spineAliasOf to borrow one) — it renders as a flat icon, not a model`
        : `${id}: assets.spine "${want}" is not in this install's model list (data/assets.json enemies) — it renders as a flat icon, not a model`,
    });
  }
  return out;
}

/**
 * Publish every pack's voice lines to the client by extending `assets.audio.voice` — the manifest the client looks an
 * operator's line up in (public/js/audio.js `voice()`), which the HTTP layer then serves merged
 * (server/index.js `buildWorkshopDataFiles` + `workshopTouchedFiles`).
 *
 * APPEND, never replace: a pack that adds lines to an operator the official data already has keeps both, and
 * `pickVoiceLine` picks among them. The DEFAULT dub's lines go into `audio.voice`; a pack's other dubs
 * (`pack.json.voiceLangs`, v0.7.3) go into `audio.voiceLangs[lang]` — the same two tables the player's 配音语言
 * setting chooses between (public/js/audio.js voiceLinesFor), so a pack line is heard exactly when the player picks
 * that dub, and a dub no pack touches is left byte-identical. Mutates `data` (a fresh copy) and records the counts in
 * `report.voices` / `report.voiceLangs`.
 *
 * An install without `data/assets.json` (the asset pipeline was never run) has no audio at all, so there is nowhere to
 * publish to: that is reported rather than silently dropped.
 */

/** Append every line of ONE index into a `<charId> → <slot> → [url]>` table; the input table is not mutated. */
function appendVoiceLines(table, index) {
  const out = { ...table };
  for (const [charId, slots] of Object.entries(index)) {
    const lines = isPlainObj(out[charId]) ? { ...out[charId] } : {};
    for (const [slot, urls] of Object.entries(slots)) {
      // The official manifest writes a slot with ONE line as a bare string and several as an array (0.2.0's
      // tools/assets/audio.mjs); the client accepts both. Normalize before appending, or a pack line would silently
      // REPLACE that single official line instead of joining it.
      const cur = lines[slot];
      const official = Array.isArray(cur) ? cur : (typeof cur === 'string' && cur ? [cur] : []);
      lines[slot] = [...new Set([...official, ...urls])];
    }
    out[charId] = lines;
  }
  return out;
}

/** Files one `<charId> → <slot> → [paths]>` table declares (the boot log counts, not a validation). */
function countVoiceLines(table) {
  let n = 0;
  if (!isPlainObj(table)) return 0;
  for (const slots of Object.values(table)) {
    if (!isPlainObj(slots)) continue;
    for (const files of Object.values(slots)) if (Array.isArray(files)) n += files.length;
  }
  return n;
}

/** Does this pack declare voice lines at all — in either table? */
const packDeclaresVoices = (pack) =>
  (isPlainObj(pack?.voices) && Object.keys(pack.voices).length > 0)
  || (isPlainObj(pack?.voiceLangs) && Object.keys(pack.voiceLangs).length > 0);

function mergeWorkshopVoices(data, packs, report) {
  const index = workshopVoiceIndex(packs);
  const langIndex = workshopVoiceLangIndex(packs);
  const langs = Object.keys(langIndex);
  if (!Object.keys(index).length && !langs.length) return;
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of Array.isArray(packs) ? packs : []) {
      if (!packDeclaresVoices(pack)) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'audio.voice', code: 'MANIFEST_MISSING',
        reason: 'this pack declares voice lines, but data/assets.json is missing — run `npm run assets` so the client has an audio manifest to extend',
      });
    }
    return;
  }
  const audio = isPlainObj(assets.audio) ? { ...assets.audio } : {};
  const voice = appendVoiceLines(isPlainObj(audio.voice) ? audio.voice : {}, index);
  /** @type {Record<string, number>} */
  const counts = {};
  // 按包 id 排序后再数：这两个 map 会随合并后的 manifest 一起发给客户端，键序不能随加载顺序变（DESIGN §28.3）
  for (const pack of (Array.isArray(packs) ? packs : []).slice().sort(byPackId)) {
    const n = countVoiceLines(pack?.voices);
    if (n) counts[pack.id] = n;
  }
  // `undefined` while no pack declares another dub: a manifest that had no `voiceLangs` must not gain an empty one.
  /** @type {Record<string, Record<string, Record<string, string[]>>>|undefined} */
  let voiceLangs;
  /** @type {Record<string, Record<string, number>>|undefined} */
  let langCounts;
  if (langs.length) {
    const base = isPlainObj(audio.voiceLangs) ? audio.voiceLangs : {};
    voiceLangs = { ...base };
    for (const [lang, idx] of Object.entries(langIndex)) {
      voiceLangs[lang] = appendVoiceLines(isPlainObj(base[lang]) ? base[lang] : {}, idx);
      for (const pack of (Array.isArray(packs) ? packs : []).slice().sort(byPackId)) {
        const n = countVoiceLines(isPlainObj(pack?.voiceLangs) && isPlainObj(pack.voiceLangs[lang]) ? pack.voiceLangs[lang] : null);
        if (n) ((langCounts ||= {})[pack.id] ||= {})[lang] = n;
      }
    }
  }
  data.assets = { ...assets, audio: { ...audio, voice, ...(voiceLangs ? { voiceLangs } : {}) } };
  report.voices = counts;
  if (langCounts) report.voiceLangs = langCounts;
}

/**
 * 包自带盟约图标的 URL 表：`{ <bondId>: '/workshop-assets/<pack>/<path>' }`。
 * 与 `workshopVoiceIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，客户端不需要任何新通道。
 * 同一个 bondId 被两个包声明时**第一个赢**，并记一条错误 —— 两个包抢同一个盟约的图标是作者要自己解决的事，
 * 静默让后加载的那个覆盖掉，会变成「换个包顺序图标就变了」这种没人能查的问题。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopBondIconIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  // 按包 id 排序再处理（与 workshopVoiceIndex 同一条规则）：谁赢只取决于包 id，不取决于加载顺序。
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const icons = isPlainObj(pack?.bondIcons) ? pack.bondIcons : null;
    if (!icons) continue;
    for (const [bondId, file] of Object.entries(icons)) {
      if (Object.hasOwn(out, bondId)) continue;
      // 逐段百分号编码：文件名里的 `#` / 空格 / 中文在 URL 里必须编码，否则 `#` 会把 URL 从此截断
      const path = String(file).split('/').map(encodeURIComponent).join('/');
      out[bondId] = `${prefix}${pack.id}/${path}`;
    }
  }
  return out;
}

/**
 * Publish every pack's 盟约图标 by extending `assets.bonds` — the map the client resolves a bond's icon in
 * (`public/js/assets.js bondIconUrl`), served merged like every other workshop overlay.
 *
 * REPLACE for a bond the official data already has (that is how a pack gives its **override** of an official bond a
 * custom icon), APPEND for a new one. Mutates `data` (a fresh copy) and records the ids in `report.bondIcons`.
 */
function mergeWorkshopBondIcons(data, packs, report) {
  const index = workshopBondIconIndex(packs);
  const ids = Object.keys(index);
  if (!ids.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 id：按包 id 排序后第一个赢，后面的写进 report.errors（不阻断，但作者必须知道）
  const claimed = new Map();
  for (const pack of list) {
    for (const bondId of Object.keys(isPlainObj(pack?.bondIcons) ? pack.bondIcons : {})) {
      if (claimed.has(bondId)) {
        report.errors.push({
          pack: pack.id, file: 'assets', id: `bonds.${bondId}`, code: 'ASSET_COLLISION',
          definedBy: claimed.get(bondId),
          reason: `another pack (${claimed.get(bondId)}) already ships an icon for this bond; keep only one`,
        });
      } else claimed.set(bondId, pack.id);
    }
  }
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of list) {
      if (!isPlainObj(pack?.bondIcons) || !Object.keys(pack.bondIcons).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'bonds', code: 'MANIFEST_MISSING',
        reason: 'this pack ships a bond icon, but data/assets.json is missing — run `npm run assets` so the client has a manifest to extend',
      });
    }
    return;
  }
  const bonds = isPlainObj(assets.bonds) ? { ...assets.bonds } : {};
  for (const id of ids) bonds[id] = index[id];
  data.assets = { ...assets, bonds };
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [bondId, packId] of claimed) (counts[packId] ??= []).push(bondId);
  for (const list of Object.values(counts)) list.sort();
  report.bondIcons = counts;
}

/**
 * 包自带装备图标的 URL 表：`{ <iconId>: '/workshop-assets/<pack>/<path>' }`。
 * 与 `workshopBondIconIndex` / `workshopVoiceIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，
 * 客户端不需要任何新通道 —— public/js/assets.js itemIconUrl 本来就在读 `assets.items`。
 * 同一个 id 被两个包声明时**第一个赢**，并记一条错误（理由与盟约图标相同：静默让后加载的那个覆盖掉，会变成
 * 「换个包顺序图标就变了」这种没人能查的问题）。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopItemIconIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  // 按包 id 排序再处理（与 workshopBondIconIndex 同一条规则）：谁赢只取决于包 id，不取决于加载顺序。
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const icons = isPlainObj(pack?.itemIcons) ? pack.itemIcons : null;
    if (!icons) continue;
    for (const [itemId, file] of Object.entries(icons)) {
      if (Object.hasOwn(out, itemId)) continue;
      // 逐段百分号编码：文件名里的 `#` / 空格 / 中文在 URL 里必须编码，否则 `#` 会把 URL 从此截断
      const path = String(file).split('/').map(encodeURIComponent).join('/');
      out[itemId] = `${prefix}${pack.id}/${path}`;
    }
  }
  return out;
}

/**
 * Publish every pack's 装备图标 by extending `assets.items` — the map the client resolves an item icon in
 * (`public/js/assets.js itemIconUrl`, which reads `item.iconId` / `item.trapId` and then looks the id up in it),
 * served merged like every other workshop overlay. **No client change**: that lookup already existed.
 *
 * REPLACE for an id the official data already has (that is how a pack gives an official equip a picture of its own),
 * APPEND for a new one. Mutates `data` (a fresh copy) and records the ids in `report.itemIcons`.
 *
 * `assets.items` that does NOT exist is left alone (the same rule as `voiceLangs`): the pack's icons are reported
 * instead, because a manifest the asset pipeline never produced is not something this overlay should invent.
 */
function mergeWorkshopItemIcons(data, packs, report) {
  const index = workshopItemIconIndex(packs);
  const ids = Object.keys(index);
  if (!ids.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 id：按包 id 排序后第一个赢，后面的写进 report.errors（不阻断，但作者必须知道）
  const claimed = new Map();
  for (const pack of list) {
    for (const itemId of Object.keys(isPlainObj(pack?.itemIcons) ? pack.itemIcons : {})) {
      if (claimed.has(itemId)) {
        report.errors.push({
          pack: pack.id, file: 'assets', id: `items.${itemId}`, code: 'ASSET_COLLISION',
          definedBy: claimed.get(itemId),
          reason: `another pack (${claimed.get(itemId)}) already ships an icon for this item; keep only one`,
        });
      } else claimed.set(itemId, pack.id);
    }
  }
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets || !isPlainObj(assets.items)) {
    for (const pack of list) {
      if (!isPlainObj(pack?.itemIcons) || !Object.keys(pack.itemIcons).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'items', code: 'MANIFEST_MISSING',
        reason: 'this pack ships an item icon, but data/assets.json has no "items" map — run `npm run assets` so the client has an icon table to extend',
      });
    }
    return;
  }
  const items = { ...assets.items };
  for (const id of ids) items[id] = index[id];
  data.assets = { ...assets, items };
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [itemId, packId] of claimed) (counts[packId] ??= []).push(itemId);
  for (const list of Object.values(counts)) list.sort();
  report.itemIcons = counts;
}

/**
 * 把包自带的外观素材变成合并后清单里的那几条：`{ <表>: { <id>: <条目，路径已换成 /workshop-assets 的绝对 URL> } }`。
 *
 * 与 `workshopVoiceIndex` / `workshopBondIconIndex` 同一套：URL 指向 /workshop-assets 那条唯一的包素材路由，客户端
 * 不需要任何新通道（`public/js/assets.js validSpine` 只要求 skel 是 `/` 开头的路径，包素材 URL 天然满足）。
 * 同一个 `<表>.<id>` 被两个包声明时**第一个赢**（按包 id 排序），后一个包在启动日志里得到一条错误。
 * @param {Array<object>} packs @param {{ prefix?: string }} [opts]
 */
export function workshopArtIndex(packs, { prefix = WORKSHOP_MEDIA_PREFIX } = {}) {
  /** @type {Record<string, Record<string, object>>} */
  const out = {};
  const toUrl = (packId, p) => `${prefix}${packId}/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  // 按包 id 排序再处理：谁赢只取决于包 id，不取决于加载顺序（与既有的三条素材通道同一条规则）
  for (const pack of [...(Array.isArray(packs) ? packs : [])].sort(byPackId)) {
    const art = isPlainObj(pack?.art) ? pack.art : null;
    if (!art) continue;
    for (const [table, entries] of Object.entries(art)) {
      const shape = ART_TABLES[table];
      if (!shape || !isPlainObj(entries)) continue;
      const bucket = (out[table] ||= {});
      for (const [id, entry] of Object.entries(entries)) {
        if (Object.hasOwn(bucket, id)) continue;
        if (shape.flat) {
          // 扁平表：条目本身就是路径，转成 URL 就是终点（没有字段可映射）；校验阶段已经确认它是安全相对路径
          if (typeof entry === 'string' && entry) bucket[id] = toUrl(pack.id, entry);
          continue;
        }
        if (!isPlainObj(entry)) continue;
        bucket[id] = artEntryUrls(entry, shape, (p) => toUrl(pack.id, p));
      }
    }
  }
  return out;
}

/** 一个条目里路径字段换成 URL 之后的副本；`spine` 按表嵌套（chars 的 front/back）或扁平（enemies/tokens）。 */
function artEntryUrls(entry, shape, toUrl) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (shape.urls.includes(key)) out[key] = toUrl(value);
    else if (shape.strings.includes(key)) out[key] = value;
    else if (key === 'spine' && isPlainObj(value)) {
      out.spine = shape.spine === 'flat'
        ? spineUrls(value, toUrl)
        : Object.fromEntries(Object.entries(value).map(([side, s]) => [side, spineUrls(s, toUrl)]));
    }
  }
  return out;
}

/** 一个 spine 对象里的路径字段换成 URL，其余（`anims`/`events`/`pma`…）原样抄。 */
function spineUrls(spine, toUrl) {
  const out = {};
  for (const [key, value] of Object.entries(spine)) {
    if (ART_SPINE_URLS.includes(key)) out[key] = toUrl(value);
    else if (ART_SPINE_LISTS.includes(key)) out[key] = value.map(toUrl);
    else out[key] = value;
  }
  return out;
}

/**
 * 把包自带的外观并进 `assets.chars` / `assets.enemies` / `assets.tokens` —— 客户端画单位与头像时读的那三张表。
 *
 * **字段级合并**，不是整条替换：包只给头像时官方模型照旧；包给 `spine.front` 的 `skel`/`atlas` 时，官方那一侧的
 * `anims`/`events` 等字段留着（整侧替换会让一个官方模型变成「能出来但不动」，而且一条日志都没有）。官方没有这个
 * id 时就是新增。`assets.json` 本身不存在（没跑过素材管线）时报告出来，不凭空造一份。
 */
function mergeWorkshopArt(data, packs, report) {
  const index = workshopArtIndex(packs);
  // 扁平表（skills / profSub）不住在 `assets.<表>` 下，它们的家是 `assets.skills` / `assets.prof.sub`，所以拿掉
  const tables = Object.keys(index).filter((t) => !ART_TABLES[t]?.flat);
  if (!tables.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  // 谁跟谁抢了同一个 <表>.<id>：按包 id 排序后第一个赢，后面的写进 report.errors
  const claimed = artClaims(list, (t) => !ART_TABLES[t]?.flat, report);
  const assets = isPlainObj(data.assets) ? data.assets : null;
  if (!assets) {
    for (const pack of list) {
      if (!isPlainObj(pack?.art) || !Object.keys(pack.art).filter((t) => !ART_TABLES[t]?.flat).length) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'art', code: 'MANIFEST_MISSING',
        reason: 'this pack ships art (avatars / portraits / spine models), but data/assets.json is missing — run `npm run assets` so the client has a manifest to extend',
      });
    }
    return;
  }
  const next = { ...assets };
  for (const table of tables) {
    const entries = isPlainObj(next[table]) ? { ...next[table] } : {};
    for (const [id, patch] of Object.entries(index[table])) {
      entries[id] = mergeArtEntry(isPlainObj(entries[id]) ? entries[id] : {}, patch);
    }
    next[table] = entries;
  }
  data.assets = next;
  report.art = artClaimCounts(claimed, (t) => !ART_TABLES[t]?.flat);
}

/**
 * 谁跟谁抢了同一张 art 表里的同一个 id：按包 id 排序后第一个赢（`claimArt`），输的一方**点名**记一条
 * `ASSET_COLLISION`（`definedBy` = 占住的那一方）。
 *
 * 两张 art 面（对象表与扁平表）共用它：规则只有一份，输出两张面孔 —— 谁赢这件事不该因为「这张表的条目是对象还是
 * 字符串」而不同。
 * @param {Array<object>} list 已按包 id 排好序的包
 * @param {(table: string) => boolean} include 这次要处理哪些表
 * @param {{ errors: object[] }} report 错误去处
 * @returns {Map<string, string>} `"<表>.<id>"` → 占住它的包 id
 */
function artClaims(list, include, report) {
  /** @type {Map<string, string>} */
  const claimed = new Map();
  for (const pack of list) {
    for (const [table, entries] of Object.entries(isPlainObj(pack?.art) ? pack.art : {})) {
      if (!ART_TABLES[table] || !include(table)) continue;
      // 扁平表的条目**是路径字符串**，`isPlainObj` 会为假 —— 用 `entries` 存在与否判断，不是「它是不是对象」
      for (const id of Object.keys(isPlainObj(entries) ? entries : {})) {
        const key = `${table}.${id}`;
        if (claimed.has(key)) {
          report.errors.push({
            pack: pack.id, file: 'assets', id: key, code: 'ASSET_COLLISION',
            definedBy: claimed.get(key),
            reason: `another pack (${claimed.get(key)}) already ships art for this entry; keep only one`,
          });
        } else claimed.set(key, pack.id);
      }
    }
  }
  return claimed;
}

/** `artClaims` 的结果按包归拢、每张表内按 key 排序（`report.art` / `report.flatArt` 的形状）。 */
function artClaimCounts(claimed, include) {
  /** @type {Record<string, string[]>} */
  const counts = {};
  for (const [key, packId] of claimed) {
    const table = key.slice(0, key.indexOf('.'));
    if (!include(table)) continue;
    (counts[packId] ??= []).push(key);
  }
  for (const arr of Object.values(counts)) arr.sort();
  return counts;
}

/**
 * 把包自带的**两张扁平图标表**并进 `assets.skills` / `assets.prof.sub`（`pack.json.art.skills` /
 * `pack.json.art.profSub`）—— 客户端画技能图标与分支图标时读的那两张表。
 *
 * 为什么单独一条通道：这两张表的值**直接就是路径字符串**（`data/assets.json` 实测：`skills["skchr_kalts_1"]`
 * 与 `prof.sub["fastshot"]`），不像 `chars` 那样是一个带 `urls` 字段的对象，所以它可以复用 `mergeWorkshopArt`
 * 的一切（路径安全规则、`/workshop-assets` 路由、包 id 排序、点名撞车），只有「写进哪一层」不同 —— 那一层由
 * `ART_TABLES[表].target` 给出（`['skills']` / `['prof','sub']`）。
 *
 * 官方已有这个 id 时**替换**（这就是一个包给官方技能换图标的方式）；`assets.json` 缺失时报告，不凭空造一份。
 */
function mergeWorkshopFlatArt(data, packs, report) {
  const index = workshopArtIndex(packs);
  const tables = Object.keys(index).filter((t) => ART_TABLES[t]?.flat);
  if (!tables.length) return;
  const list = [...(Array.isArray(packs) ? packs : [])].sort(byPackId);
  const claimed = artClaims(list, (t) => ART_TABLES[t]?.flat, report);
  if (!isPlainObj(data.assets)) {
    for (const pack of list) {
      if (!Object.keys(isPlainObj(pack?.art) ? pack.art : {}).some((t) => ART_TABLES[t]?.flat)) continue;
      report.errors.push({
        pack: pack.id, file: 'assets', id: 'art', code: 'MANIFEST_MISSING',
        reason: 'this pack ships skill / sub-profession icons, but data/assets.json is missing — run `npm run assets` so the client has an icon table to extend',
      });
    }
    return;
  }
  const next = { ...data.assets };
  for (const table of tables) {
    // `target` 就是那张表在 `assets.json` 里的路径：`['skills']` 或 `['prof','sub']`。**逐个**段浅复制
    // （长度 1 时落点就是 `assets.skills` 这个表本身 —— 要往表里写，不是把整张表换成一条路径）。
    const chain = [];
    let cur = /** @type {Record<string, any>} */ (next);
    for (const seg of ART_TABLES[table].target) {
      const inner = isPlainObj(cur[seg]) ? { ...cur[seg] } : {};
      chain.push({ owner: cur, key: seg, value: inner });
      cur = inner;
    }
    for (const [id, url] of Object.entries(index[table])) cur[id] = url;
    for (let i = chain.length - 1; i >= 0; i--) chain[i].owner[chain[i].key] = chain[i].value;
  }
  data.assets = next;
  report.flatArt = artClaimCounts(claimed, (t) => ART_TABLES[t]?.flat);
}

/** 一个条目按字段合并；`spine` 再往里一层（一侧之内的字段逐项合并，见 mergeWorkshopArt 的注释）。 */
function mergeArtEntry(cur, patch) {
  const out = { ...cur };
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'spine' || !isPlainObj(value)) { out[key] = value; continue; }
    const spine = isPlainObj(cur.spine) ? { ...cur.spine } : {};
    for (const [k, v] of Object.entries(value)) {
      spine[k] = isPlainObj(v) && isPlainObj(spine[k]) ? { ...spine[k], ...v } : v;
    }
    out.spine = spine;
  }
  return out;
}

/**
 * 一个包声明要进**自选池**的干员，逐条判定它能不能进（`pack.json.operators`，docs/WORKSHOP.md §1.2）。
 *
 * 与 `workshopSupportEntries` 同一种结构、同一种理由（**规则只有一份**，加载期与校验器/编辑器读的是同一个函数）：
 * 每一条声明要么给出它落盘时要写的数据，要么给出一条**点名**的拒绝。四条规则：
 *
 *   * `OPERATOR_NO_UNIT` —— 这个包没有同名的 `units[charId]` 记录。没有干员记录的干员进池后是**空槽**：
 *     自选界面画不出名字与职业，一局里也取不到 def。这是唯一一条「写成什么样都不该放过」的错。
 *   * `OPERATOR_NOT_SIX` —— `rarity !== 6`。**不是 6★ 请走工坊棋子注册表**（`content.chess` + `kits/<chessId>.js`）：
 *     自选池这一层是「六星干员的获得方式」，5★ 与以下在这条路上没有商店阶级可落。
 *   * `OPERATOR_BOND_UNKNOWN` —— `bonds` 里某个 id 不在 `data/bonds.json`。**这条必须拒**：盟约 id 写错时那条
 *     盟约条**永远不会出现**（`assets.bonds` 里没有它的图标，`bonds` 表里没有它的阈值），而作者只会以为
 *     「盟约没生效」—— 一次完全静默的失效。
 *   * `OPERATOR_FORM_MISSING` —— `forms` 没覆盖自选槽要的档位。自选槽的普通与精锐两条记录**各自**要求一个档位
 *     （`shared/diy.js checkDiyPick` 同时解析两条），缺一个这个干员就挑不上；更重的是 `tools/golden.mjs` 会给池里
 *     每位配一个精锐场景，所以缺档位会让**语料生成抛异常**，`golden` / `ci` 全线挂。要求的那一组从 `diy.slots`
 *     派生（`requiredUnitForms`），不硬编码。
 *   * `PACK_ID_COLLISION` —— 两个包声明同一个 charId。按包 id 字典序最小者赢（DESIGN §28.3），输的一方得到一条
 *     点名报告；`ownedPool` 因此只会多一个 id，不会出现两条记录抢一个槽。
 *
 * `name` / `rarity` / `profession` / `subProfessionId` **从 `data.backups.units[charId]` 派生**（同一个包的
 * `units` 记录已经由内容文件那一层并进 `data` 了），所以清单里写不出第二份会漂移的真相。
 *
 * @param {Readonly<Record<string, any>>} data 合并后的数据（`units` 记录已就位）
 * @param {Array<{ id: string, operators?: Record<string, { powers?: string[], bonds?: string[] }> }>} packs
 * @returns {{ entries: Array<{ pack: string, id: string, rec: object }>, errors: object[] }}
 */
export function workshopOperatorEntries(data, packs) {
  /** @type {Array<{ pack: string, id: string, rec: object }>} */
  const entries = [];
  /** @type {object[]} */
  const errors = [];
  const list = (Array.isArray(packs) ? packs : []).filter((p) => p && typeof p.id === 'string' && p.id).sort(byPackId);
  const units = isPlainObj(data) && isPlainObj(data.backups) && isPlainObj(data.backups.units) ? data.backups.units : {};
  const bonds = isPlainObj(data) && isPlainObj(data.bonds) ? data.bonds : {};
  /** charId → 已经声明它的包（`byPackId` 顺序下第一个就是赢家）。 */
  const claimed = new Map();
  for (const pack of list) {
    const declared = isPlainObj(pack.operators) ? pack.operators : {};
    for (const charId of Object.keys(declared).sort()) {
      const decl = isPlainObj(declared[charId]) ? declared[charId] : {};
      const unit = isPlainObj(units[charId]) ? units[charId] : null;
      if (!unit) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_NO_UNIT',
          reason: `"${charId}" has no units record in this pack — declare it in units.json (the 自选池 entry derives its name / rarity / profession from that record)`,
        });
        continue;
      }
      if (unit.rarity !== 6) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_NOT_SIX',
          reason: `"${charId}" is rarity ${JSON.stringify(unit.rarity)}, not 6 — the 自选池 is the 6★ path; a 5★ or lower operator goes through the workshop chess registry instead (content.chess + kits/<chessId>.js)`,
        });
        continue;
      }
      const unknown = (Array.isArray(decl.bonds) ? decl.bonds : []).filter((b) => !isPlainObj(bonds[b]));
      if (unknown.length) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_BOND_UNKNOWN',
          reason: `"${charId}" declares the bond(s) ${unknown.map((b) => `"${b}"`).join(', ')}, which data/bonds.json does not have — that bond would simply never appear in a match (a mistyped id fails silently; check data/bonds.json for the exact id, e.g. "egirShip")`,
        });
        continue;
      }
      // 形态齐不齐：自选槽的两条记录（普通 + 精锐）各自要求一个 forms 档位，缺一个这个干员**根本挑不上**
      // （shared/diy.js checkDiyPick 同时解析两条）。而它的后果不止「挑不上」：`tools/golden.mjs` 会给池里每一位
      // 配一个 tier-6 精锐场景，所以一个缺档位的干员进池 = 语料生成抛异常 = `golden` / `ci` 全线挂（2026-10-09 实测：
      // 只有 `2/1/4/0` 与 `2/60/7/1` 两个档位的干员会让 `chess_char_6_diy1_a` 报 `no form for`）。
      // 要求的那一组**从 `diy.slots` 的两条记录派生**（shared/diy.js requiredUnitForms），不硬编码 `2/60/7/3`。
      const forms = isPlainObj(unit.forms) ? unit.forms : {};
      const missing = requiredUnitForms(data).filter((f) => !isPlainObj(forms[f]));
      if (missing.length) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'OPERATOR_FORM_MISSING',
          reason: `"${charId}" has no unit form for ${missing.map((f) => `"${f}"`).join(', ')} — the 自选 slots' normal and elite records both need one (data/backups.json diy.slots => chess status), and a pool member without them cannot be picked: \`node tools/golden.mjs\` throws and the golden / ci suites go down with it. Copy the missing form(s) from the operator record you derived this one from`,
        });
        continue;
      }
      const holder = claimed.get(charId);
      if (holder) {
        errors.push({
          pack: pack.id, file: 'backups', id: charId, code: 'PACK_ID_COLLISION', definedBy: holder,
          reason: `"${charId}" is already contributed by pack "${holder}" — the pack with the smaller id keeps it (DESIGN §28.3). Rename this record, or let "${holder}" drop it; an "overrides" entry does not win against another pack`,
        });
        continue;
      }
      claimed.set(charId, pack.id);
      entries.push({
        pack: pack.id,
        id: charId,
        rec: {
          name: unit.name,
          rarity: unit.rarity,
          profession: unit.profession,
          subProfessionId: unit.subProfessionId,
          obtainable: true,
          powers: [...(Array.isArray(decl.powers) ? decl.powers : [])],
          bonds: [...(Array.isArray(decl.bonds) ? decl.bonds : [])],
        },
      });
    }
  }
  return { entries, errors };
}

/**
 * 把包声明的新干员**放进自选池**：`data/backups.json` 的 `diy.ownedPool`（push，去重）与
 * `diy.operators[charId]`（那张自选界面读的名字 / 星级 / 职业 / 盟约表）。
 *
 * 这是「新增一个干员」从**就地补丁**变成**包**的最后一块：在它之前，一个包能带干员记录、能带素材、能带语音，
 * 但它加的新干员在自选界面里**根本不存在**（`diy` 只认生成器写出来的那 86 条）；作者只能手改
 * `data/backups.json`，而那是生成物 —— 下次 `npm run build-data` 会把他的条目整条抹掉。
 *
 * `data/*.json` 依旧一个字节都不改：叠加发生在 `deepFreeze` 之前（docs/WORKSHOP.md §1.3），所以
 * 「作者能加」与「生成器是唯一来源」同时成立 —— 磁盘上的 `ownedPool.length === 71` 那几条生成器契约
 * （`test/backups.test.js`）完全不受影响。
 *
 * 入池顺序只由包 id 排序决定（`workshopOperatorEntries` 内部就是 `byPackId`），不依赖目录扫描顺序。
 * `data.backups` 不存在时报告 `MANIFEST_MISSING`，不凭空造一份（与 art 缺 `assets.json` 同一手法）。
 */
function mergeWorkshopOperators(data, packs, report) {
  const { entries, errors } = workshopOperatorEntries(data, packs);
  for (const e of errors) report.errors.push(e);
  if (!entries.length) return;
  const backups = isPlainObj(data.backups) ? data.backups : null;
  const diy = backups && isPlainObj(backups.diy) ? backups.diy : null;
  if (!diy) {
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.pack)) continue;
      seen.add(e.pack);
      report.errors.push({
        pack: e.pack, file: 'backups', id: 'diy', code: 'MANIFEST_MISSING',
        reason: 'this pack declares 自选池 operators, but data/backups.json has no "diy" map — run `npm run build-data` so the 自选 pool has somewhere to publish to',
      });
    }
    return;
  }
  const pool = [...(Array.isArray(diy.ownedPool) ? diy.ownedPool : [])];
  const operators = { ...(isPlainObj(diy.operators) ? diy.operators : {}) };
  /** @type {Record<string, string[]>} */
  const added = {};
  for (const { pack, id, rec } of entries) {
    // 已经在这个池里（一个官方干员、或者……）时不再 push：`ownedPool` 是一份「拥有哪些干员」的集合，
    // 两个条目一个 id 只会让自选界面出现两个一样的格子。
    if (!pool.includes(id)) pool.push(id);
    operators[id] = rec;
    (added[pack] ||= []).push(id);
  }
  for (const list of Object.values(added)) list.sort();
  data.backups = { ...backups, diy: { ...diy, ownedPool: pool, operators } };
  report.operators = added;
}

/**
 * Make newly added STAGES selectable.
 *
 * A stage only enters a match when the mode's `stages` list names it (server/match/waves.js picks among those by
 * `weight`) — and `config` is deliberately NOT a workshop-contributable file, because a pack that could rewrite config
 * could rewrite the economy and the round schedule. So instead of letting a pack ship a config overlay, the loader
 * honours the stage's OWN `modes` list by APPENDING its id to those mode entries. Nothing else in `config` is ever
 * written, and only stages the pack actually added are linked.
 *
 * Mutates `data.config` (a fresh copy) and records each link in `report.linkedStages` so the boot log can show it.
 */
function linkWorkshopStages(data, report) {
  const added = Array.isArray(report.added.stages) ? report.added.stages : [];
  if (!added.length || !isPlainObj(data.stages) || !isPlainObj(data.config) || !isPlainObj(data.config.modes)) return;
  const modes = { ...data.config.modes };
  let touched = false;
  for (const id of added) {
    const stage = data.stages[id];
    const declared = stage && Array.isArray(stage.modes) ? stage.modes : [];
    for (const modeId of declared) {
      const mode = modes[modeId];
      if (!isPlainObj(mode)) continue;
      const list = Array.isArray(mode.stages) ? mode.stages.slice() : [];
      if (list.includes(id)) continue;
      list.push(id);
      modes[modeId] = { ...mode, stages: list };
      touched = true;
      (report.linkedStages ||= []).push(`${id} -> ${modeId}`);
    }
  }
  if (touched) data.config = { ...data.config, modes };
}

/**
 * One-line summary of a merge report for the boot log / `--doctor`.
 * @param {ReturnType<typeof applyWorkshop>['report']} report
 */
export function workshopSummary(report) {
  if (!report || !Array.isArray(report.packs) || !report.packs.length) return 'no workshop packs';
  const parts = report.packs.map((p) => {
    const bits = [];
    const files = Object.entries(p.files).filter(([, n]) => n.added || n.overridden)
      .map(([f, n]) => `${f} +${n.added}${n.overridden ? ` ~${n.overridden}` : ''}`);
    if (files.length) bits.push(files.join(', '));
    const voices = report.voices && report.voices[p.id];
    const langVoices = report.voiceLangs && report.voiceLangs[p.id];
    if (voices || langVoices) {
      // the default dub first, then each extra dub with its own count: `3 voice lines (jp 2, en 1)`
      const perLang = langVoices ? Object.entries(langVoices).map(([l, n]) => `${l} ${n}`).join(', ') : '';
      const head = voices ? `${voices} voice line${voices === 1 ? '' : 's'}` : 'voice lines';
      bits.push(perLang ? `${head} (${perLang})` : head);
    }
    const icons = report.bondIcons && report.bondIcons[p.id];
    if (icons) bits.push(`${icons.length} bond icon${icons.length === 1 ? '' : 's'}`);
    const itemIcons = report.itemIcons && report.itemIcons[p.id];
    if (itemIcons) bits.push(`${itemIcons.length} item icon${itemIcons.length === 1 ? '' : 's'}`);
    const art = report.art && report.art[p.id];
    if (art) bits.push(`${art.length} art entr${art.length === 1 ? 'y' : 'ies'} (${art.join(', ')})`);
    // 扁平图标表（`assets.skills` / `assets.prof.sub`）与上面那条分开数：它们的落点不是 `assets.<表>`，
    // 一条日志里混在一起会让读的人去 assets.chars 里找一个技能图标。
    const flatArt = report.flatArt && report.flatArt[p.id];
    if (flatArt) bits.push(`${flatArt.length} icon${flatArt.length === 1 ? '' : 's'} (${flatArt.join(', ')})`);
    const support = report.support && report.support[p.id];
    if (support) bits.push(`助战 +${support.length}`);
    const operators = report.operators && report.operators[p.id];
    if (operators) bits.push(`自选池 +${operators.length}`);
    const looks = (report.looks || []).filter((l) => l.pack === p.id);
    // 干员与怪物分开数：一句话里混着「3 个干员」而其中两个是怪物，读日志的人会去找错对象
    const lookOperators = looks.filter((l) => l.kind !== 'enemy').length;
    const lookEnemies = looks.length - lookOperators;
    if (lookOperators) bits.push(`${lookOperators} 个干员没有模型（会画成贴图）`);
    if (lookEnemies) bits.push(`${lookEnemies} 个怪物没有模型（会画成贴图）`);
    return `${p.name}(${p.id}): ${bits.length ? bits.join(', ') : 'nothing'}`;
  });
  if (report.supportOff) parts.push('助战 pool contributions off (support.json "workshop": false)');
  if (report.errors.length) parts.push(`${report.errors.length} rejected record(s)`);
  return parts.join('; ');
}
