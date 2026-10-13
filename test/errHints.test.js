// test/errHints.test.js — 错误码白话表（editor/ui/errHints.zh.js，A5）与「校验这个包」那条只读端点（B1）。
//
// 这一层存在的理由：界面以前只把引擎的英文原文原样打出来（`[EMPTY_PACK] content must name at least one of: …`），
// 而那是在回答「引擎为什么不收」，不是在回答「我该改哪个字」。两条契约必须有牙：
//
//   1. **十条码逐条**都要有人话 + 一条修法（少一条就失败 —— 表被删空、键名打错都会红）；
//   2. **查不到的码必须回落显示原文**，一个字都不许省略、不许变成空白、不许变成「未知错误」。
//      这一条是防「静默」的：引擎里有一百多条码，没进表的那九十多条不能让作者看到一片空白。
//
// ⚠ 带牙证明（去掉接线 ⇒ 必红）：
//   * 把 `errHints.zh.js` 的 `explainCode` 改成永远 `return { known: false, plain: '', fix: '' }` ⇒ 「十条逐条」
//     那一组红（它断言 known === true）。
//   * 把 `errLine` 的回落分支改成 `return ''` ⇒ 「未知码必须回落」那一条红。
//   * 把 `editor/server.mjs` 那条 `/api/packs/<id>/validate` 路由注释掉 ⇒ 「只读端点」那一组红（404）。
//   * 把 `editor/server.mjs` 里传给 `validateWorkshop` 的 `root` 换成别的目录 ⇒ 「与 CLI 同一结论」那条红。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { ERR_HINTS, hintFor, explainCode, errLine } from '../editor/ui/errHints.zh.js';
import { createEditorServer } from '../editor/server.mjs';
import { setLang, currentLang } from '../editor/ui/i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

/** 这十条是「小白最常撞的」（侦察方案：`_up/workshop-ui/00-界面侦察与优化方案.md` 第三节 A5）。 */
const TEN = ['EMPTY_PACK', 'PACK_ID_COLLISION', 'ASSETS_NEED_LICENSE', 'PACK_ID_MISMATCH', 'PACK_UNKNOWN_FIELD',
  'BAD_API_TYPE', 'ART_NEEDS_ASSETS', 'TRAIT_GRANT_BAD_SHAPE', 'TRAIT_GRANT_EMPTY', 'TRAIT_GRANT_UNKNOWN_BOND'];

describe('错误码白话表：十条逐条', () => {
  test('十条码全都在表里，每一条都有「一句人话」与「一条修法」', () => {
    for (const code of TEN) {
      const hit = hintFor(code);
      assert.ok(hit, `${code} 不在 ERR_HINTS 里`);
      assert.equal(typeof hit.plain, 'string');
      assert.equal(typeof hit.fix, 'string');
      assert.ok(hit.plain.trim().length >= 8, `${code} 的「一句话人话」太短，像占位符：${JSON.stringify(hit.plain)}`);
      assert.ok(hit.fix.trim().length >= 8, `${code} 的「修法」太短，像占位符：${JSON.stringify(hit.fix)}`);
    }
  });

  test('表里没有多余的键（多一条就该在这条断言里被看见）', () => {
    assert.deepEqual(Object.keys(ERR_HINTS).sort(), [...TEN].sort());
  });

  test('十条码逐条：explainCode 都给 known = true，且原文一字不少', () => {
    for (const code of TEN) {
      const e = explainCode(code);
      assert.equal(e.known, true, `${code} 没被翻出来`);
      assert.equal(e.code, code);
      assert.ok(e.plain.trim(), `${code} 的人话是空的`);
      assert.ok(e.fix.trim(), `${code} 的修法是空的`);
      const line = errLine({ code, detail: `${code}_DETAIL`, field: 'some.field' });
      assert.ok(line.includes(`[${code}]`), `行里必须带码：${line}`);
      assert.ok(line.includes('some.field'), `行里必须带字段定位：${line}`);
      assert.ok(line.includes('修法'), `行里必须给修法：${line}`);
      // 引擎原文照旧附上（作者要能跟 CLI / 日志对得上）
      assert.ok(line.includes(`${code}_DETAIL`), `行里必须保留引擎原文：${line}`);
    }
  });

  test('人话与引擎原文是两回事：人话里不出现引擎那句英文判据', () => {
    const e = explainCode('ASSETS_NEED_LICENSE');
    assert.ok(!/must declare a license/i.test(e.plain), '人话不该是英文判据的复制');
  });
});

describe('错误码白话表：查不到必须回落显示原文（绝不静默）', () => {
  test('hintFor 对未知码返回 null（而不是空对象或编一句「未知错误」）', () => {
    for (const bad of ['NOT_A_REAL_CODE', '', null, undefined, 42, {}]) {
      assert.equal(hintFor(bad), null, `${JSON.stringify(bad)} 不该命中`);
    }
  });

  test('explainCode 对未知码给 known = false 且两句话都为空（调用方必须自己打原文）', () => {
    const e = explainCode('SOME_CODE_FROM_THE_FUTURE');
    assert.equal(e.known, false);
    assert.equal(e.plain, '');
    assert.equal(e.fix, '');
    assert.equal(e.code, 'SOME_CODE_FROM_THE_FUTURE');
  });

  test('errLine 对未知码回落成 `[CODE] 原文`，一个字都不省略', () => {
    const detail = 'the engine said something we have no plain-language entry for';
    const line = errLine({ code: 'SOME_CODE_FROM_THE_FUTURE', detail });
    assert.equal(line, `[SOME_CODE_FROM_THE_FUTURE] ${detail}`);
    assert.ok(!line.includes('未知'), '回落行里不许出现「未知错误」这种二次改写');
  });

  test('errLine 对未知码 + 字段给 `[CODE] field：原文`', () => {
    assert.equal(errLine({ code: 'X_Y', detail: 'boom', field: 'art.chars.a.spine' }), '[X_Y] art.chars.a.spine：boom');
  });

  test('errLine 对缺 detail / 缺 code 不炸（页面上任何一条都能渲染出来）', () => {
    assert.equal(errLine({ code: 'EMPTY_PACK' }).split('\n')[0].startsWith('[EMPTY_PACK]'), true);
    assert.equal(errLine({}).trim(), '[]');
    assert.equal(errLine(null).trim(), '[]');
  });

  test('未知码里的英文原文在没有 detail 时也不会变成空白', () => {
    const line = errLine({ code: 'MYSTERY_CODE' });
    assert.equal(line.trim(), '[MYSTERY_CODE]');
  });
});

describe('错误码白话表：英文界面下也有人话（不退回中文）', () => {
  test('切到 en 之后十条仍然有内容，且不是中文', () => {
    const before = currentLang();
    try {
      setLang('en');
      for (const code of TEN) {
        const e = explainCode(code);
        assert.equal(e.known, true, `${code} 在英文界面下也必须命中`);
        assert.ok(e.plain.trim(), `${code} 在英文界面下的人话是空的`);
        assert.ok(!/[\u4e00-\u9fff]/.test(e.plain), `${code} 的英文人话里还有中文：${e.plain}`);
        assert.ok(!/[\u4e00-\u9fff]/.test(e.fix), `${code} 的英文修法里还有中文：${e.fix}`);
      }
    } finally {
      setLang(before);
    }
  });
});

// ---- B1：只读的「校验这个包」端点 --------------------------------------------------------------------------------

/** 一份**合法**的最小包（一条 chess 记录，成对的普通 / 精锐 + 自带模型），照 workshop-validate 的判据能过。 */
function writeGoodPack(root, id) {
  const dir = join(root, id);
  fs.mkdirSync(join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(join(dir, 'pack.json'), `${JSON.stringify({
    id, name: '校验端点夹具', version: '1.0.0', author: 'test', license: 'CC0-1.0',
    description: '「校验这个包」端点的夹具（test/errHints.test.js）', content: ['chess'],
  }, null, 2)}\n`);
  fs.writeFileSync(join(dir, 'chess.json'), `${JSON.stringify({
    [`chess_ws_${id}_a`]: {
      chessId: `chess_ws_${id}_a`, charId: `char_ws_${id}`, name: '夹具干员', rarity: 4,
      profession: 'WARRIOR', subProfessionId: 'hammer', position: 'MELEE', dmgType: 'phys',
      attackKind: 'melee', canHitFly: false, tier: 4, cost: 12, blockCnt: 2,
      stats: { maxHp: 2000, atk: 300, def: 200, res: 0, bat: 1.2, respawnTime: 70 },
      rangeGrid: [[0, 0]], talents: [], bonds: [], immunities: [],
      isDiy: false, isHidden: false, isGolden: false, visible: true,
      assets: { spine: 'char_ws_fixture' },
      goldenId: `chess_ws_${id}_b`, baseId: null,
    },
    [`chess_ws_${id}_b`]: {
      chessId: `chess_ws_${id}_b`, charId: `char_ws_${id}`, name: '夹具干员', rarity: 4,
      profession: 'WARRIOR', subProfessionId: 'hammer', position: 'MELEE', dmgType: 'phys',
      attackKind: 'melee', canHitFly: false, tier: 4, cost: 12, blockCnt: 2,
      stats: { maxHp: 2400, atk: 380, def: 240, res: 0, bat: 1.2, respawnTime: 70 },
      rangeGrid: [[0, 0]], talents: [], bonds: [], immunities: [],
      isDiy: false, isHidden: false, isGolden: true, visible: false,
      assets: { spine: 'char_ws_fixture' },
      goldenId: null, baseId: `chess_ws_${id}_a`,
    },
  }, null, 2)}\n`);
  return dir;
}

describe('校验这个包：只读端点（B1）', () => {
  let tmp; let wsRoot; let editor; let goodId; let badId;

  before(async () => {
    tmp = fs.mkdtempSync(join(tmpdir(), 'sp-validate-endpoint-'));
    wsRoot = join(tmp, 'workshop');
    fs.mkdirSync(wsRoot, { recursive: true });
    goodId = 'good-pack';
    badId = 'bad-pack';
    writeGoodPack(wsRoot, goodId);
    // 一份会被拒的包：pack.json 里有一个引擎不认识的字段（PACK_UNKNOWN_FIELD）
    fs.mkdirSync(join(wsRoot, badId), { recursive: true });
    fs.writeFileSync(join(wsRoot, badId, 'pack.json'), JSON.stringify({
      id: badId, name: '坏包', version: '1.0.0', license: 'CC0-1.0', description: 'unknown field',
      type: 'operator-editor', content: ['chess'],
    }));
    const supportFile = join(tmp, 'support.json');
    fs.copyFileSync(join(DATA_DIR, 'support.json'), supportFile);
    editor = await createEditorServer({ workshopRoot: wsRoot, port: 0, host: '127.0.0.1', supportFile });
  });
  after(async () => {
    await editor?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (path) => fetch(`${editor.url}${path}`);

  test('GET 一条合法包：装上、errors 与 checks 都给出来', async () => {
    const res = await get(`/api/packs/${goodId}/validate`);
    assert.equal(res.status, 200, '这条只读端点要能回答');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.pack, goodId);
    assert.equal(body.status, 'loaded', `这个包该被装载：${JSON.stringify(body)}`);
    assert.ok(Number.isInteger(body.errors), 'errors 必须是整数');
    assert.ok(Number.isInteger(body.warnings), 'warnings 必须是整数');
    assert.ok(Array.isArray(body.checks), 'checks 必须是数组（界面按它渲染逐条）');
    // 每条 check 都得有界面要的四样：层、码、严重度、原文
    for (const c of body.checks) {
      assert.equal(typeof c.kind, 'string');
      assert.ok(c.kind, `每一条都要有层名：${JSON.stringify(c)}`);
      assert.equal(typeof c.code, 'string');
      assert.ok(['error', 'warning'].includes(c.severity), `severity 只能是 error / warning：${JSON.stringify(c)}`);
      assert.equal(typeof c.message, 'string');
    }
  });

  test('GET 一条被拒的包：说清 status = refused 并带理由（不是 200 空壳）', async () => {
    const res = await get(`/api/packs/${badId}/validate`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'refused', `这个包该被拒：${JSON.stringify(body)}`);
    assert.ok(String(body.reason ?? '').includes('PACK_UNKNOWN_FIELD'), `理由要点名那条码：${body.reason}`);
    const errs = body.checks.filter((c) => c.severity === 'error');
    assert.ok(errs.length >= 1, 'checks 里必须至少有那条 error');
    assert.ok(errs.some((c) => c.code === 'PACK_UNKNOWN_FIELD'), JSON.stringify(errs));
  });

  test('这条端点只读：GET 之后磁盘上一个字节都没变', async () => {
    /** 递归列出这个根下每个文件的相对路径 + 字节数（含子目录）。 */
    const snapshot = (dir = wsRoot, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const p = join(dir, e.name);
      if (e.isDirectory()) return snapshot(p, rel);
      return [`${rel}:${fs.statSync(p).size}`];
    }).sort();
    const before = snapshot();
    await get(`/api/packs/${goodId}/validate`);
    await get(`/api/packs/${badId}/validate`);
    assert.deepEqual(snapshot(), before, '校验端点不许写盘');
  });

  test('这条端点只认 GET：POST 不给（方法闸门）', async () => {
    const res = await fetch(`${editor.url}/api/packs/${goodId}/validate`, { method: 'POST' });
    assert.ok(res.status === 404 || res.status === 405, `POST 不该被当成校验：HTTP ${res.status}`);
  });

  test('包 id 走路径穿越的形状 ⇒ 400/404，不许去读工坊根之外', async () => {
    for (const bad of ['..', '..%2F..%2Fetc', 'a/b', '.hidden']) {
      const res = await get(`/api/packs/${encodeURIComponent(bad)}/validate`);
      assert.ok(res.status === 400 || res.status === 404, `${bad} 该被挡下，实际 HTTP ${res.status}`);
    }
  });

  test('不存在的包 ⇒ 404（而不是 500 或一份空报告）', async () => {
    const res = await get('/api/packs/no-such-pack-here/validate');
    assert.equal(res.status, 404);
  });

  test('与 CLI 同一个结论：界面报的错误条数与 CLI 对**这一个包**的账逐条相同', async () => {
    const { validateWorkshop } = await import('../shared/workshopValidate.mjs');
    for (const id of [goodId, badId]) {
      const cli = await validateWorkshop({ root: wsRoot, only: id });
      const body = await (await get(`/api/packs/${id}/validate`)).json();
      // CLI 对单个包的报告：`packs[].issues` + `engine` + `checks` 三本账相加
      const cliCodes = [
        ...(cli.packs.find((x) => x.pack === id)?.issues ?? []),
        ...(cli.engine ?? []),
        ...(cli.checks ?? []),
      ].map((i) => `${i.severity}:${i.code}:${i.field ?? ''}`).sort();
      const uiCodes = (body.checks ?? []).map((c) => `${c.severity}:${c.code}:${c.field ?? ''}`).sort();
      assert.deepEqual(uiCodes, cliCodes, `${id}：界面与 CLI 必须给同一批问题（同一份 validateWorkshop）`);
      assert.equal(body.errors + body.warnings, uiCodes.length, `${id}：总数要与逐条对得上`);
    }
  });
});
