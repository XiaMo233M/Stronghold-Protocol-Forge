// 工坊包给**已有语种**补词条（`pack.json.i18n`, fanpack G-04 / plugin-pack G4, docs/WORKSHOP.md §1.10）。
//
// 这份测试钉住三件事，三件都是「失败方向是静默」的那一类：
//
//   1. **形状**：`{ "<语种>": "<包内 .json>" }` —— 语种码必须是我们认的常用大小写、不能是源语言 `zh`、路径必须是包内
//      相对 `.json`。任一不合法 → 整包拒绝（`I18N_*`），不是「读过去当没看见」。
//   2. **装载期**：声明的文件必须真的在包里、是 JSON 对象、每个值都是字符串 —— 否则**整个包不加载**（与 `assets`
//      / `client` / `server.preDispatch` 同一条纪律，DESIGN §28.13.3）。
//   3. **合并规则**：**已有键绝不覆盖**、冲突**点名报告**（键 + 语种 + 包 id + 双方的值）、值相同的重叠不算冲突。
//      真实用例是 plugin-pack 那份 74 键的补丁：它只有 `语音语言` 这一条与我们重叠，而 `en` 的值不同
//      （`Voice language` vs `Voice Language`），ja / ko / zh-TW 三份逐字相同。
//
// 后半段走**真的 HTTP 服务器**：`/i18n/<code>.json` 送的是合并体，而 `public/i18n/<code>.json` 一个字节都不改。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  normalizePackManifest, parsePackI18n, mergeWorkshopI18n, workshopI18nFiles,
} from '../shared/workshop.js';
import { loadWorkshop, i18nIssues, readUiLangFile } from '../server/workshop.js';
import { buildWorkshopI18nFiles } from '../server/http/workshop.js';
import { startServer } from '../server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** 我们自己的那份语言文件（真读盘，不是抄一份 fixture —— 冲突判据就是「与我们已发布的译文比」）。 */
const ourLang = (code) => JSON.parse(fs.readFileSync(join(ROOT, 'public', 'i18n', `${code}.json`), 'utf8'));

/**
 * plugin-pack 那份真实 i18n 补丁里**与我们重叠的那一条**：`语音语言`。
 * 键相同、`en` 的值不同（`Voice language` vs `Voice Language`），ja / ko / zh-TW 三份逐字相同
 * （原始证据：`_up/plugin-pack/_work/out-selfcheck3.json` 的 `collidingKey`）。
 */
const COLLIDING_KEY = '语音语言';
const THEIR_EN = 'Voice language';

/** 一个包的最小清单：`i18n` 就是被测的那一个字段。 */
const norm = (extra = {}, opts = {}) => normalizePackManifest({ id: 'p', content: ['chess'], ...extra }, 'p', opts);

let tmp;
let wsRoot;
const packDir = (id, root = wsRoot) => join(root, id);
const writePack = (id, raw, files = {}, root = wsRoot) => {
  fs.mkdirSync(packDir(id, root), { recursive: true });
  fs.writeFileSync(join(packDir(id, root), 'pack.json'), `${JSON.stringify(raw, null, 2)}\n`);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(packDir(id, root), ...rel.split('/'));
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
};
const load = (dir = wsRoot) => loadWorkshop(dir, { log: quiet });

before(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'sp-ws-i18n-'));
  wsRoot = join(tmp, 'workshop');
  fs.mkdirSync(wsRoot, { recursive: true });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe('i18n: the declaration shape (pack.json.i18n)', () => {
  test('an absent field adds no key at all (an existing pack keeps its bytes)', () => {
    const r = norm();
    assert.equal(r.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(r.pack, 'i18n'), false, '缺省 ⇒ 归一化清单里没有这个键');
    const declared = norm({ i18n: { en: 'i18n/en.json' } });
    assert.deepEqual(declared.pack.i18n, { en: 'i18n/en.json' });
  });

  test('a pack that declares ONLY i18n is a legal pack (it contributes strings)', () => {
    const r = normalizePackManifest({ id: 'p', content: [], i18n: { en: 'i18n/en.json' } }, 'p', {});
    assert.equal(r.ok, true, r.detail);
    // 空对象不算贡献：与 `routes: []` / 空的 `client.panels` 同一条语义
    assert.equal(normalizePackManifest({ id: 'p', content: [], i18n: {} }, 'p', {}).error, 'EMPTY_PACK');
  });

  test('every way the declaration can be wrong is refused by name', () => {
    const cases = [
      [{ i18n: [] }, 'I18N_BAD_SHAPE'],
      [{ i18n: 'en' }, 'I18N_BAD_SHAPE'],
      [{ i18n: { EN: 'i18n/en.json' } }, 'I18N_BAD_LANG'],
      [{ i18n: { 'pt_br': 'i18n/pt.json' } }, 'I18N_BAD_LANG'],
      [{ i18n: { zh: 'i18n/zh.json' } }, 'I18N_SOURCE_LANG'],
      [{ i18n: { en: '/abs/en.json' } }, 'I18N_BAD_FILE'],
      [{ i18n: { en: '../en.json' } }, 'I18N_BAD_FILE'],
      [{ i18n: { en: 'i18n/en.txt' } }, 'I18N_BAD_FILE'],
      [{ i18n: { en: '' } }, 'I18N_BAD_FILE'],
    ];
    for (const [raw, code] of cases) {
      const r = norm(raw);
      assert.equal(r.ok, false, `${JSON.stringify(raw)} 必须被拒`);
      assert.equal(r.error, code, `${JSON.stringify(raw)}: ${r.detail}`);
    }
  });

  test('canonical language codes in their usual case are accepted', () => {
    const files = { en: 'i18n/en.json', ja: 'i18n/ja.json', 'zh-TW': 'i18n/zh-TW.json', 'pt-BR': 'i18n/pt-BR.json' };
    const r = norm({ i18n: files });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.pack.i18n, files);
  });
});

describe('i18n: merging into an existing language', () => {
  test('an existing key is NEVER overwritten, and the difference is reported by name', () => {
    const base = { _meta: { lang: 'en' }, '开始': 'Start', [COLLIDING_KEY]: 'Voice Language' };
    const merged = mergeWorkshopI18n(base, { [COLLIDING_KEY]: THEIR_EN, '新词条': 'New string' }, { pack: 'quickchat', lang: 'en' });
    assert.equal(merged.ok, true, merged.detail);
    assert.equal(merged.merged[COLLIDING_KEY], 'Voice Language', '官方的译文原样留着');
    assert.equal(merged.merged['新词条'], 'New string', '缺的键补上了');
    assert.equal(merged.merged['开始'], 'Start');
    assert.deepEqual(merged.merged._meta, base._meta, '语言文件自己的 _meta 原样保留');
    assert.deepEqual(merged.added, ['新词条']);
    assert.equal(merged.conflicts.length, 1);
    assert.deepEqual(
      { ...merged.conflicts[0] },
      { pack: 'quickchat', lang: 'en', key: COLLIDING_KEY, official: 'Voice Language', packValue: THEIR_EN },
      '冲突要点名 键 + 语种 + 包 id + 双方的值',
    );
    assert.equal(base['新词条'], undefined, '输入对象不许被改');
  });

  test('an overlap whose value is IDENTICAL is not a conflict (it is counted, not listed)', () => {
    // plugin-pack 的 `语音语言` 在 ja / ko / zh-TW 三份里与我们逐字相同 —— 那三条不该进报告。
    for (const code of ['ja', 'ko', 'zh-TW']) {
      const ours = ourLang(code)[COLLIDING_KEY];
      const r = mergeWorkshopI18n(ourLang(code), { [COLLIDING_KEY]: ours }, { pack: 'quickchat', lang: code });
      assert.equal(r.ok, true);
      assert.deepEqual(r.conflicts, [], `${code}: 值相同不是冲突`);
      assert.equal(r.skippedSame, 1, `${code}: 但要数出来（报告不能漏掉「它是重叠的」）`);
      assert.deepEqual(r.added, []);
    }
    // en 那份值不同 ⇒ 一条冲突，且官方值赢
    const en = mergeWorkshopI18n(ourLang('en'), { [COLLIDING_KEY]: THEIR_EN }, { pack: 'quickchat', lang: 'en' });
    assert.equal(en.conflicts.length, 1);
    assert.equal(en.merged[COLLIDING_KEY], ourLang('en')[COLLIDING_KEY]);
    assert.notEqual(en.merged[COLLIDING_KEY], THEIR_EN);
    assert.equal(en.skippedSame, 0);
  });

  test('the real plugin-pack patch: 74 keys, THREE already ours, conflicts named per language', () => {
    // 这份补丁的真实内容（`E:\destop\卫戍协议-插件包-v0.2.1\④ i18n补丁\<code>.新增键.json`）—— 74 键 × 4 语种。
    // 本机没有那份原文时跳过（它不在仓库里，是业主侧的交付物）。
    //
    // 重叠键有**三条**，都是**事实**而非错误：
    //   * `语音语言` —— 真冲突，只在 **en**（官方 "Voice Language" vs 补丁 "Voice language"，只差大小写）；
    //   * `快速匹配` —— 0.13.0 起引擎自己就带这一条（野排匹配落地），四语种与补丁**逐字相同** ⇒ 「已有且同值」；
    //   * `发送`     —— 0.13.0 起引擎自己就带这一条（房内聊天落地，docs/META.md §1.8）：en / ja / zh-TW 同值，
    //                  **ko 不同**（我们 "전송"，补丁 "보내기"）⇒ ko 多一条真冲突。
    // 合并规则是「已有键绝不覆盖 + 值不同就点名」，所以 added 恒为 71，冲突按语种分别是 en 1 / ko 1 / ja 0 / zh-TW 0。
    const QUICK_MATCH_KEY = '快速匹配';
    const SEND_KEY = '发送';
    const SHARED = [COLLIDING_KEY, QUICK_MATCH_KEY, SEND_KEY];
    const CONFLICT_LANG = { [COLLIDING_KEY]: 'en', [SEND_KEY]: 'ko' };
    const src = 'E:\\destop\\卫戍协议-插件包-v0.2.1\\④ i18n补丁';
    if (!fs.existsSync(src)) {
      assert.ok(true, '本机没有那份补丁原文，跳过这一条（插件包不在仓库里）');
      return;
    }
    for (const code of ['en', 'ja', 'ko', 'zh-TW']) {
      const entries = JSON.parse(fs.readFileSync(join(src, `${code}.新增键.json`), 'utf8'));
      assert.equal(Object.keys(entries).length, 74, `${code}: 74 键`);
      const ours = ourLang(code);
      const overlap = Object.keys(entries).filter((k) => Object.hasOwn(ours, k));
      assert.deepEqual(overlap.slice().sort(), SHARED.slice().sort(), `${code}: 与我们重叠的就是这三条`);
      // 逐条核对「哪一语种真的不同」：这条断言同时是「不许为了过测试去改文案」的守卫 ——
      // 引擎自带的那两条必须与补丁一致（ko 的 发送 除外），否则就是两条译文真的对不上。
      const expected = Object.entries(CONFLICT_LANG).filter(([, lang]) => lang === code).map(([k]) => k);
      for (const k of SHARED) {
        assert.equal(entries[k] !== ours[k], expected.includes(k),
          `${code}: "${k}" 两边${entries[k] !== ours[k] ? '不同' : '相同'}，与实测的冲突表不符`);
      }
      const r = mergeWorkshopI18n(ours, entries, { pack: 'quickchat-en', lang: code });
      assert.equal(r.ok, true, r.detail);
      assert.equal(r.added.length, 71, `${code}: 补上 71 条（74 键里 3 键我们已有）`);
      assert.equal(r.conflicts.length, expected.length, `${code}: 冲突条数`);
      assert.equal(r.skippedSame, SHARED.length - expected.length, `${code}: 值相同而不计的条数`);
      for (const k of expected) {
        assert.ok(r.conflicts.some((c) => c.key === k), `${code}: 冲突必须点名 "${k}"`);
      }
      if (code === 'en') {
        const c = r.conflicts.find((x) => x.key === COLLIDING_KEY);
        assert.equal(c.official, 'Voice Language');
        assert.equal(c.packValue, 'Voice language');
      }
      assert.equal(Object.keys(r.merged).length, Object.keys(ours).length + 71);
    }
  });

  test('values must be strings: anything else refuses with the pack', () => {
    for (const value of [['a'], { a: 1 }, 7, null, true]) {
      const r = mergeWorkshopI18n({}, { '词条': value }, { pack: 'p', lang: 'en' });
      assert.equal(r.ok, false, `${JSON.stringify(value)} 必须被拒`);
      assert.equal(r.error, 'I18N_BAD_VALUE');
      assert.match(r.detail, /"en"/, '提示要点名是哪个语种');
    }
    const key = mergeWorkshopI18n({}, { _meta: 'x' }, { pack: 'p', lang: 'en' });
    assert.equal(key.error, 'I18N_BAD_KEY', '`_` 开头的是语言文件的元数据块，不是词条');
    const shape = mergeWorkshopI18n({}, ['not', 'an', 'object'], { pack: 'p', lang: 'en' });
    assert.equal(shape.error, 'I18N_BAD_FILE');
  });
});

describe('i18n: two packs, one language (the smaller pack id wins)', () => {
  test('the loser is reported by name instead of silently doing nothing', () => {
    const packs = [
      { id: 'zeta', i18n: { en: 'i18n/en.json' } },
      { id: 'alpha', i18n: { en: 'i18n/en.json' } },
    ];
    const { langs, overridden } = parsePackI18n(packs);
    assert.equal(langs.get('en').pack.id, 'alpha', '包 id 小的赢（DESIGN §28.3）');
    assert.equal(overridden.length, 1);
    assert.equal(overridden[0].pack, 'zeta');
    assert.equal(overridden[0].definedBy, 'alpha');
    assert.match(overridden[0].reason, /already contributed by pack "alpha"/);
  });

  test('workshopI18nFiles reads the winner, merges, and reports the collision', () => {
    const packs = [
      { id: 'zeta', i18n: { en: 'i18n/en.json' } },
      { id: 'alpha', i18n: { en: 'i18n/a.json', ja: 'i18n/a-ja.json' } },
    ];
    const read = { alpha: { 'i18n/a.json': { '新词': 'New', '开始': 'Nope' }, 'i18n/a-ja.json': { '新词': '新規' } } };
    const r = workshopI18nFiles(packs, (pack, file) => read[pack]?.[file] ?? null, (lang) => (lang === 'en' ? { '开始': 'Start' } : {}));
    assert.deepEqual(r.errors, []);
    assert.equal(r.files.get('en')['开始'], 'Start', '已有键不覆盖');
    assert.equal(r.files.get('en')['新词'], 'New');
    assert.equal(r.files.get('ja')['新词'], '新規');
    assert.deepEqual(r.added.alpha, ['en:新词', 'ja:新词']);
    assert.equal(r.conflicts.length, 2, '一条是 en 的键冲突，一条是 zeta 被 alpha 挤掉');
    assert.ok(r.conflicts.some((c) => c.key === '开始' && c.pack === 'alpha'));
    assert.ok(r.conflicts.some((c) => c.pack === 'zeta' && c.definedBy === 'alpha'));
  });
});

describe('i18n: the load-time gate (a declared file that cannot be used refuses the pack)', () => {
  test('a missing file / a non-object / a non-string value each refuse the whole pack', () => {
    // 每个用例住自己的工坊根：loader 只列**根目录下**的包，而 `i18n/` 这个子目录名会让根目录自己看起来像一包。
    const caseRoot = (id) => join(tmp, 'gate', id);
    writePack('p', { id: 'p', content: [], i18n: { en: 'i18n/en.json' } }, {}, caseRoot('missing'));
    writePack('p', { id: 'p', content: [], i18n: { en: 'i18n/en.json' } }, { 'i18n/en.json': '[1,2,3]' }, caseRoot('notobject'));
    writePack('p', { id: 'p', content: [], i18n: { en: 'i18n/en.json' } }, { 'i18n/en.json': { '词条': ['x'] } }, caseRoot('badvalue'));
    writePack('p', { id: 'p', content: [], i18n: { en: 'i18n/en.json' } }, { 'i18n/en.json': '{ not json' }, caseRoot('broken'));

    for (const id of ['missing', 'notobject', 'badvalue', 'broken']) {
      const r = loadWorkshop(caseRoot(id), { log: quiet });
      assert.equal(r.packs.length, 0, `${id}: 整个包不加载`);
      assert.equal(r.errors.length, 1, `${id}: ${JSON.stringify(r.errors)}`);
      assert.match(r.errors[0].reason, /^I18N_/, `${id}: ${r.errors[0].reason}`);
    }
    // 路径穿越在形状层就被拒（`isSafeRelativePath` 判 `..`），所以它根本走不到装载期。
    const escape = caseRoot('escape');
    writePack('p', { id: 'p', content: [], i18n: { en: 'i18n/../../en.json' } }, {}, escape);
    assert.equal(i18nIssues({ id: 'p', i18n: { en: 'i18n/../../en.json' } }, packDir('p', escape), readUiLangFile).length, 1);
    assert.equal(norm({ i18n: { en: 'i18n/../../en.json' } }).error, 'I18N_BAD_FILE');
  });

  test('a good pack loads, and the i18n files are part of its identity', () => {
    const root = join(tmp, 'identity');
    writePack('good', { id: 'good', content: ['chess'], i18n: { en: 'i18n/en.json' } }, {
      'chess.json': { chess_ws_a: { chessId: 'chess_ws_a', charId: 'char_ws_a', name: 'A', tier: 1 } },
      'i18n/en.json': { '新词条': 'New string' },
    }, root);
    const one = load(root);
    assert.deepEqual(one.errors, []);
    assert.equal(one.packs.length, 1);
    const before = one.packs[0].hash;
    assert.ok(one.packs[0].manifest.some((m) => m.path === 'i18n/en.json'), '译文文件进哈希清单');
    // 换一份译文 ⇒ 换一个身份（能改变玩家看到的东西的字节不该躲在摘要之外）
    fs.writeFileSync(join(packDir('good', root), 'i18n', 'en.json'), JSON.stringify({ '新词条': 'Another string' }, null, 2));
    const after = load(root).packs[0].hash;
    assert.notEqual(after, before);
  });
});

describe('i18n: what the browser gets (a real server, a real /i18n/<code>.json)', () => {
  let server;
  let publicBefore;
  /** 这台服务器的工坊根：只放这一个包（`wsRoot` 只用来做「单包目录」的那些用例）。 */
  let serverRoot;

  before(async () => {
    serverRoot = join(tmp, 'server-workshop');
    writePack('quickchat', { id: 'quickchat', name: 'Quick chat', content: ['chess'], i18n: { en: 'i18n/en.json' } }, {
      'chess.json': { chess_ws_a: { chessId: 'chess_ws_a', charId: 'char_ws_a', name: 'A', tier: 1 } },
      'i18n/en.json': { '工坊新词条': 'From the pack', [COLLIDING_KEY]: THEIR_EN },
    }, serverRoot);
    server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: serverRoot, dataDir: DATA_DIR });
    publicBefore = fs.readFileSync(join(ROOT, 'public', 'i18n', 'en.json'), 'utf8');
  });
  after(async () => { await server?.close(); });

  test('/i18n/en.json is the MERGED body: the new key arrives, the existing one keeps our value', async () => {
    const res = await fetch(`${server.url}/i18n/en.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body['工坊新词条'], 'From the pack');
    assert.equal(body[COLLIDING_KEY], ourLang('en')[COLLIDING_KEY], '已有键绝不覆盖');
    assert.notEqual(body[COLLIDING_KEY], THEIR_EN);
    assert.ok(body._meta && body._meta.lang === 'en', '语言文件自己的 _meta 原样保留');
    assert.equal(Object.keys(body).length, Object.keys(ourLang('en')).length + 1, '只多一条');
  });

  test('a language no pack declares is served from disk, byte for byte', async () => {
    const res = await fetch(`${server.url}/i18n/ja.json`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, fs.readFileSync(join(ROOT, 'public', 'i18n', 'ja.json'), 'utf8'));
  });

  test('the file on disk is NOT rewritten (the merge happens on the way out)', () => {
    assert.equal(fs.readFileSync(join(ROOT, 'public', 'i18n', 'en.json'), 'utf8'), publicBefore);
  });

  test('a fresh install with no i18n pack has an empty merged map (nothing is touched)', () => {
    const loaded = loadWorkshop(join(tmp, 'empty'), { log: quiet });
    assert.equal(loaded.present, false);
    assert.equal(buildWorkshopI18nFiles(loaded, { log: quiet }).size, 0);
    assert.equal(buildWorkshopI18nFiles({ packs: [] }, { log: quiet }).size, 0);
  });

  test('the boot log names the conflict (键 + 语种 + 包 id)', () => {
    const lines = [];
    buildWorkshopI18nFiles(load(serverRoot), { log: { warn: (m) => lines.push(m) } });
    const line = lines.find((l) => l.includes(COLLIDING_KEY));
    assert.ok(line, `没有报冲突：${JSON.stringify(lines)}`);
    assert.match(line, /i18n en/);
    assert.match(line, /quickchat/);
    assert.match(line, /Voice language/);
  });
});
