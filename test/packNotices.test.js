// test/packNotices.test.js — 公告与鸣谢这一层**载体**（DESIGN §28.15，插件包 G5）。
//
// 这一格缺的先是**产品面**：仓库里原本没有「公告」这个载体的任何形态。所以这里验的第一件事是载体真的存在，
// 而且**引擎那一半不手写** —— 公告由 `CHANGELOG.md` 生成（单一事实源），鸣谢来自引擎自己的名单。包那一半
// （`pack.json.notices`）是**追加**语义：两个包的公告不会互相覆盖，引擎的也不会被包顶掉。
//
// Run: node --test test/packNotices.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { normalizePackManifest, PACK_FIELDS } from '../shared/workshop.js';
import { loadWorkshop } from '../server/workshop.js';
import { engineAnnouncements, engineNotices, workshopNotices, NOTICE_LIMITS } from '../server/notices.js';
import { startServer } from '../server/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const EXAMPLES = path.join(ROOT, 'docs/examples');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('声明层：`notices` 的形状', () => {
  const base = (extra = {}) => ({ id: 'p', name: 'p', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.x', ...extra });
  const norm = (extra) => normalizePackManifest(base(extra), 'p', { hasAssets: false });

  test('`notices` 是顶层键闭集的一员（拼错的键照旧点名拒绝）', () => {
    assert.ok(PACK_FIELDS.includes('notices'));
    const r = norm({ notices: { annoucement: 'a.json' } });   // 故意的拼错
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NOTICES_UNKNOWN_FIELD');
  });

  test('合法声明：两个成员都是包内相对 .json', () => {
    const r = norm({ notices: { announcement: 'notice/a.json', credits: 'notice/c.json' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
    assert.deepEqual(r.pack.notices, { announcement: 'notice/a.json', credits: 'notice/c.json' });
  });

  test('每一种写错的形状都点名拒绝', () => {
    const bad = (notices, code, note) => {
      const r = norm({ notices });
      assert.equal(r.ok, false, `${note}: 应当被拒`);
      assert.equal(r.error, code, `${note}: 期待 ${code}，实际 ${r.error} — ${r.detail}`);
    };
    bad('x', 'NOTICES_BAD_SHAPE', '不是对象');
    bad({}, 'NOTICES_EMPTY', '空对象');
    bad({ announcement: 'a.txt' }, 'NOTICES_BAD_PATH', '不是 .json');
    bad({ credits: '/abs/c.json' }, 'NOTICES_BAD_PATH', '绝对路径');
    bad({ credits: '../c.json' }, 'NOTICES_BAD_PATH', '爬出包');
  });

  test('只声明 `notices` 的包是合法包（贡献项）', () => {
    const r = norm({ notices: { announcement: 'a.json' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.error} — ${r.detail}`);
  });
});

describe('引擎那一半：公告从更新记录生成', () => {
  test('认得出节、日期、摘要与小节条目（不认识的写法跳过而不是猜）', () => {
    const list = engineAnnouncements({ changelogPath: CHANGELOG });
    assert.ok(list.length >= 1, '仓库的更新记录里应当至少有一条能生成公告');
    const first = list[0];
    assert.match(first.version, /^\d+\.\d+\.\d+$/);
    assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(first.summary.length > 10, '摘要要有内容');
    assert.ok(first.sections.length >= 1, '至少一个小节');
    for (const section of first.sections) {
      assert.ok(section.name && section.items.length, JSON.stringify(section));
      assert.ok(section.items.every((i) => typeof i === 'string' && i && i.length <= NOTICE_LIMITS.itemChars));
    }
    assert.ok(list.length <= NOTICE_LIMITS.announcements, '条数有上限');
  });

  test('读不到更新记录时是空数组（不是抛异常）', () => {
    assert.deepEqual(engineAnnouncements({ changelogPath: path.join(ROOT, 'nope.md') }), []);
  });

  test('三种实测过的形状都要认：标题带 `-<上游>` 半边、正文写在小节标题下面、通篇没有小节', () => {
    // 三处实测过的漏（合起来让玩家看到的公告最新一条停在 0.14.0，而当时发的就是 0.16.0）：
    // ① 正则原来要求版本后面直接跟空白 ⇒ `## 0.16.0-0.2.4 — …` 这类节全被跳过；
    // ② 摘要原来必须落在第一个 `###` 之前 ⇒ 「`##` 紧跟 `###`、正文在小节标题下面」的节取不到摘要，
    //    整条被丢掉；
    // ③ 原来还要求「至少一个小节」⇒ 通篇没有 `###` 的节（0.15.0–0.15.3）`sections` 是空的，整条被丢掉。
    //   判据现在与客户端同一条（`public/js/ui/notices.js`：`version` + `summary` 就能展示）。
    // `test/version.test.js` 早就认标题的那半边，这里跟它对齐。
    const file = path.join(tmpdir(), `sp-changelog-shapes-${process.pid}.md`);
    fs.writeFileSync(file, [
      '# 更新记录', '',
      '## 9.9.9-0.2.4 — 2030-01-01', '',
      '### 一节', '',
      '正文写在小节标题下面。', '',
      '- 一条', '',
      '## 9.9.8-0.2.4 — 2030-01-02', '',
      '正文在第一个 `###` 之前。', '',
      '### 又一节', '',
      '- 另一条', '',
      '## 9.9.7-0.2.4 — 2030-01-03', '',
      '通篇没有小节，条目直接挂在标题下面。', '',
      '* 一条直接挂在 ## 下的条目', '',
      '## 9.9.6-0.2.4 — 2030-01-04', '',
      '### 只有小节标题、没有正文',
      '',
    ].join('\n'));
    try {
      const list = engineAnnouncements({ changelogPath: file });
      assert.deepEqual(list.map((a) => a.version), ['9.9.9', '9.9.8', '9.9.7'], '前三节都要认出来');
      assert.equal(list[0].summary, '正文写在小节标题下面。', '`###` 下面的第一段正文也算摘要');
      assert.deepEqual(list[0].sections[0].items, ['一条']);
      assert.equal(list[0].date, '2030-01-01');
      assert.equal(list[1].summary, '正文在第一个 `###` 之前。');
      assert.deepEqual(list[1].sections[0].items, ['另一条']);
      assert.equal(list[2].summary, '通篇没有小节，条目直接挂在标题下面。', '没有 `###` 的节也发得出去');
      assert.deepEqual(list[2].sections, [], '`##` 下的条目不属于任何小节，不替它编一个小节名');
      // 连正文都没有的节（只有 `###`）仍然跳过 —— 它确实没有可展示的摘要，不拿标题行顶上
      assert.equal(list.some((a) => a.version === '9.9.6'), false);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('更新记录最上面那一节一定在公告里（公告不许悄悄漏掉当前版本）', () => {
    const top = fs.readFileSync(CHANGELOG, 'utf8').match(/^##\s+(\d+\.\d+\.\d+)/m);
    assert.ok(top, '更新记录里应当有 `## x.y.z` 标题');
    const list = engineAnnouncements({ changelogPath: CHANGELOG });
    assert.ok(list.length, '至少有一条公告');
    assert.equal(list[0].version, top[1], `公告最新一条是 ${list[0].version}，而更新记录最上面是 ${top[1]}`);
  });

  test('引擎的鸣谢有内容且网址都是 https', () => {
    const { credits } = engineNotices({ changelogPath: CHANGELOG });
    assert.ok(credits.length >= 3);
    for (const c of credits) {
      assert.ok(c.name);
      if (c.url) assert.match(c.url, /^https:\/\//);
    }
  });
});

describe('装载期 + 合并 + 真 HTTP', () => {
  let tmp;
  let wsRoot;
  let srv;
  let clean;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(tmpdir(), 'sp-notices-'));
    wsRoot = path.join(tmp, 'ws');
    const dir = path.join(wsRoot, 'notice-pack');
    fs.mkdirSync(path.join(dir, 'notice'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
      id: 'notice-pack', name: 'Notice', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      notices: { announcement: 'notice/a.json', credits: 'notice/c.json' },
    }));
    fs.writeFileSync(path.join(dir, 'notice', 'a.json'), JSON.stringify({
      version: '1.0.0', date: '2026-10-10', summary: '这是这个包的公告。',
      sections: [{ name: '做了什么', items: ['第一件', '第二件'] }],
    }));
    fs.writeFileSync(path.join(dir, 'notice', 'c.json'), JSON.stringify([
      { name: '某位作者', note: '画了图标', url: 'https://example.com/author' },
      { name: '另一位' },
      { name: '坏网址', url: 'http://insecure.example.com' },
      { note: '没有名字' },
    ]));
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: wsRoot });
    clean = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workshopDir: EXAMPLES });
  });
  after(async () => {
    if (srv) await srv.close();
    if (clean) await clean.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('声明的公告文件不在包里 ⇒ 整包被拒并点名', () => {
    const dir = path.join(tmp, 'missing');
    fs.mkdirSync(path.join(dir, 'gone'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gone', 'pack.json'), JSON.stringify({
      id: 'gone', name: 'Gone', version: '1.0.0', license: 'CC0-1.0', description: 'x', gameVersion: '0.2.2',
      notices: { announcement: 'notice/nope.json' },
    }));
    const loaded = loadWorkshop(dir, { log: quiet });
    assert.equal(loaded.packs.some((p) => p.id === 'gone'), false);
    assert.match(loaded.errors.find((e) => e.pack === 'gone').reason, /NOTICES_BAD_FILE/);
  });

  test('声明的公告字节进内容哈希', () => {
    const before = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'notice-pack');
    assert.ok(before.manifest.some((m) => m.path === 'notice/a.json'), '公告源码在身份清单里');
    const file = path.join(wsRoot, 'notice-pack', 'notice', 'a.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', date: '2026-10-10', summary: '改了摘要', sections: [] }));
    const after = loadWorkshop(wsRoot, { log: quiet }).packs.find((p) => p.id === 'notice-pack');
    assert.notEqual(after.hash, before.hash);
    fs.writeFileSync(file, original);
  });

  test('合并：引擎的在前，包的按包 id 追加；挤到上限时丢的是**引擎最旧**的那条', () => {
    const loaded = loadWorkshop(wsRoot, { log: quiet });
    const { body, errors } = workshopNotices(loaded, { changelogPath: CHANGELOG });
    const engine = engineAnnouncements({ changelogPath: CHANGELOG });
    assert.equal(body.announcements.length, NOTICE_LIMITS.announcements, '上限就是合并体的长度');
    const mine = body.announcements[body.announcements.length - 1];
    assert.equal(mine.pack, 'notice-pack', '包的一条在最后，没有被引擎挤掉');
    assert.equal(mine.version, '1.0.0');
    assert.deepEqual(mine.sections[0].items, ['第一件', '第二件']);
    assert.equal(body.announcements[0].pack, null, '引擎那一条没有包归属');
    // 引擎列表是「新 → 旧」；被丢的是最旧那条（在末尾），最新的那条照旧在
    assert.equal(body.announcements[0].version, engine[0].version, '最新的引擎公告还在');
    if (engine.length >= NOTICE_LIMITS.announcements) {
      const oldest = engine[engine.length - 1].version;
      assert.equal(body.announcements.some((a) => a.version === oldest && a.pack === null), false, `最旧的那条（${oldest}）应当被挤掉`);
    }
    // 署名：两条合法、坏网址与没名字的被点名跳过
    const names = body.credits.map((c) => c.name);
    assert.ok(names.includes('某位作者') && names.includes('另一位'));
    assert.equal(names.includes('坏网址'), false);
    assert.equal(errors.some((e) => e.code === 'NOTICES_BAD_URL'), true, JSON.stringify(errors));
    assert.equal(errors.some((e) => e.reason.includes('non-empty name')), true);
    assert.deepEqual(errors.map((e) => e.pack), errors.map(() => 'notice-pack'));
  });

  test('真 HTTP：`/data/notices.json` 送的是合并体', async () => {
    const res = await fetch(`${srv.url}/data/notices.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /json/);
    const body = await res.json();
    assert.ok(Array.isArray(body.announcements) && body.announcements.length >= 2);
    assert.equal(body.announcements.some((a) => a.pack === 'notice-pack'), true);
    assert.ok(body.credits.some((c) => c.name === 'Stronghold-Protocol-Forge'), '引擎的鸣谢在里面');
  });

  test('一个包都不声明公告的安装：这个端点仍然存在（引擎那一半），内容是引擎自己的', async () => {
    const res = await fetch(`${clean.url}/data/notices.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.announcements.length >= 1);
    assert.equal(body.announcements.every((a) => a.pack === null), true, '没有包归属');
    assert.equal(JSON.stringify(body).includes('notice-pack'), false);
  });
});
