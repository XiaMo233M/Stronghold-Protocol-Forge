#!/usr/bin/env node
// .github/pack-compat.mjs —— 拿**工坊站线上在跑的包**喂给本仓（引擎）自己的校验器，看它们今天还装不装得上。
//
//   node .github/pack-compat.mjs [--base http://47.103.14.217:25570] [--mine-only] [--list-only]
//
// 为什么用引擎自己的 `tools/workshop-validate.mjs` 而不是本脚本自己写一套判据：
// 包的格式、层级判定与拒绝理由**是引擎决定的**，抄一份就等于规则一升级就漂（同 `tools/check-packs.mjs` 的理由）。
// 为什么解压用引擎的 `shared/zip.js`：条目名是 UTF-8，Info-ZIP 会按 CP437 解出乱码文件名 ⇒ 假拒绝。
// 而且**故意用 zipRead 的默认上限**（64 MiB / 4096 条 / 单文件 32 MiB）——超限就是引擎真装不上，不是取样偏差。
//
// 退出码：0 = 没有「我方包的新增不兼容」；1 = 有；2 = 用法/清单取不到（清单取不到绝不报绿）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd().replace(/\\/g, '/');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
// 默认就是**本仓自己的**工坊站，不需要凭据、本脚本对站只做 GET（/api/mods 与 zip 下载）。
const BASE = arg('--base', 'http://47.103.14.217:25570');
const MINE_ONLY = argv.includes('--mine-only');
const WORK = arg('--work', `${ROOT}/.pack-compat`);
// 「我方」= 本仓（上游 / 维护方）在站上的身份串。
//
// 为什么不能直译上游仓主名：这条工具是从下游 fork 吸收来的，那边写的是 `/jingjiangze/i`（**他们的**仓主名）。
// 我们自己的身份串是 `Mo233`（站上 34 条 functional 包的 author/compatAuthor 字段），
// 而 `/XiaMo233M/i`（照 GitHub 仓主名直译）在站上命中 **0 条** —— 那会让 `--mine-only` 变成「0 条判定」，
// 而本脚本只在 `!rows.length` 时报 exit 2，于是**静默报绿**，正是这个闸门要防的事。
const MINE = /Mo233|XiaMo233M/i;
// ⚠️ 只测**身份字段**，不拿整个对象去 test：包名 / 备注里出现 `Mo233` 只是文字巧合，
// 那不是「我方包」（会削弱闸门），所以按字段收窄。站侧把 compatAuthor 当权威改写署名用
// （另有 `sp-modsite 站侧维护` 这类站侧值），所以两个身份字段都要看。
const isMine = (m) => MINE.test(String(m?.author ?? '')) || MINE.test(String(m?.compatAuthor ?? ''));

fs.mkdirSync(WORK, { recursive: true });
const { zipRead } = await import(pathToFileURL(`${ROOT}/shared/zip.js`).href);
// 包的 id 规则**由引擎决定**，所以直接读它的 `PACK_ID_RE`（shared/workshop.js:117），别再在这里抄一份：
// 原来写的是 `/^[a-z0-9][a-z0-9._-]{1,63}$/`，比引擎**既严又松** —— 大写开头的合法 id（如 `dongShip`）
// 被误判成 BAD_PACK_ID 且**跳过校验**，而 33–64 字符或含 `.` 的 id 反而被放行（引擎会拒）。
const { PACK_ID_RE } = await import(pathToFileURL(`${ROOT}/shared/workshop.js`).href);

const get = (u, dest) => {
  const r = spawnSync('curl', ['-sL', '-m', '240', '-o', dest, u], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0;
};
/**
 * 取存档并**按字节数确认完整**：站点入口在大文件上会中途断连（本机实测 4 MB 起断），
 * 截断的 zip 会让 zipRead 报 `ZIP_BAD_EOCD` —— 那是**传输问题**，绝不能报成「引擎判拒这个包」。
 * 所以：对不上 `m.size` 就重试，重试用完记 `TRUNCATED_DOWNLOAD`（独立档位，不算兼容性结论）。
 */
/** 不 spawn 外部进程的可中断等待（CI 与本机同一行为） */
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const getFull = (u, dest, want) => {
  for (let a = 1; a <= 5; a++) {
    if (fs.existsSync(dest) && fs.statSync(dest).size === want) return 'ok';
    if (fs.existsSync(dest) && want && fs.statSync(dest).size !== want) fs.rmSync(dest);
    if (!get(u, dest)) { console.log(`  下载第 ${a} 次失败，重试`); nap(3000); continue; }
    if (!want || fs.statSync(dest).size === want) return 'ok';
    console.log(`  字节不匹配（有 ${fs.statSync(dest).size} / 声明 ${want}），第 ${a} 次重试`);
    nap(3000);
  }
  return 'truncated';
};
const listPath = path.join(WORK, 'mods.json');
if (!get(`${BASE}/api/mods`, listPath)) { console.error(`::error::取不到 ${BASE}/api/mods`); process.exit(2); }
const doc = JSON.parse(fs.readFileSync(listPath, 'utf8'));
const mods = doc.mods ?? [];
// ⚠️ `/api/mods` 有**两个**数组，`flagged` 过去整个被漏掉。它装着被标疑的包，其中有引擎**真拒**的
// （实测一条 pack.json 带未知顶层字段 ⇒ PACK_UNKNOWN_FIELD，而它又不在 mods 里）—— 只看 mods 的闸门
// 永远看不到这一类。两个数组一起测。
const flagged = doc.flagged ?? [];
if (!mods.length && !flagged.length) { console.error('::error::线上清单是空的（这不等于「全部兼容」）'); process.exit(2); }
const srcOf = new Map([...mods.map((m) => [m.id, 'mods']), ...flagged.map((m) => [m.id, 'flagged'])]);
const all = [...mods, ...flagged];

// `mods` 沿用原来的判据（functional 且可下载）；`flagged` 不看 packKind —— 里面就有 packKind
// `unknown` / `documentation` 的真包，而循环对「没有 pack.json」本来就会优雅降级成 NO_PACK_JSON。
const target = all.filter((m) => m.download && (!MINE_ONLY || isMine(m))
  && (srcOf.get(m.id) === 'flagged' || m.packKind === 'functional'));
console.log(`清单可见 mods=${mods.length} flagged=${flagged.length}（合计 ${all.length}）；本轮校验 ${target.length} 条`
  + `（来自 flagged 的 ${target.filter((m) => srcOf.get(m.id) === 'flagged').length} 条，--mine-only=${MINE_ONLY}）`);

const rows = [];
for (const m of target) {
  const rec = { id: m.id, src: srcOf.get(m.id) ?? null, name: m.name, kind: m.kind, packId: m.packId ?? null, compatOf: m.compatOf ?? null,
    author: m.author ?? null, compatAuthor: m.compatAuthor ?? null, size: m.size, stage: '', codes: [], notes: [] };
  const z = path.join(WORK, `${m.id}.zip`);
  const url = /^https?:/.test(m.download) ? m.download : BASE + m.download;
  if (getFull(url, z, m.size) !== 'ok') {
    rec.stage = 'TRUNCATED_DOWNLOAD';
    rec.notes.push(`有 ${fs.existsSync(z) ? fs.statSync(z).size : 0} 字节 / 站点声明 ${m.size}`);
    rows.push(rec); console.log(`⚠ ${m.id} 下载不完整（重试 5 轮）—— 这条**不出兼容性结论**`); continue;
  }
  const r = zipRead(fs.readFileSync(z));
  if (!r.ok) { rec.stage = 'ZIP_REFUSED'; rec.codes.push(r.error); rec.notes.push(r.detail); rows.push(rec); console.log(`✗ ${m.id} zip 被引擎判拒 ${r.error}`); continue; }
  const stageRoot = path.join(WORK, m.id);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  // 先落一遍，找到 pack.json 到底在哪一层
  const raw = path.join(stageRoot, '_in');
  for (const e of r.entries) {
    const f = path.join(raw, e.name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, e.data);
  }
  const found = [];
  (function walk(d) {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p);
      else if (x.name === 'pack.json') found.push(p);
    }
  })(raw);
  if (!found.length) {
    rec.stage = 'NO_PACK_JSON';
    rows.push(rec);
    console.log(`- ${m.id} 没有 pack.json（说明/参考类条目，不参与装载判定）`);
    continue;
  }
  if (found.length > 1) rec.notes.push(`包里有 ${found.length} 个 pack.json，取第一个`);
  const packSrc = path.dirname(found[0]);                       // 站点常套一层顶层文件夹
  const prefix = packSrc.slice(raw.length + 1).replace(/\\/g, '/');
  let pid;
  try { pid = String(JSON.parse(fs.readFileSync(found[0], 'utf8')).id || ''); } catch (e) { pid = ''; }
  if (!PACK_ID_RE.test(pid)) {
    rec.stage = 'BAD_PACK_ID'; rec.codes.push('PACK_ID_UNUSABLE'); rec.notes.push(`pack.json id = ${JSON.stringify(pid).slice(0, 60)}`);
    rows.push(rec); console.log(`✗ ${m.id} pack.json 的 id 不能当目录名：${pid}`); continue;
  }
  // 引擎的硬判据是 **目录名必须等于 pack.json.id**（PACK_ID_MISMATCH），所以按真实 id 重新落一遍
  const destDir = path.join(stageRoot, pid);
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of r.entries) {
    if (prefix && !e.name.startsWith(prefix + '/')) continue;
    const rel = prefix ? e.name.slice(prefix.length + 1) : e.name;
    if (!rel) continue;
    const f = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, e.data);
  }
  fs.rmSync(raw, { recursive: true, force: true });
  const root = stageRoot;                                        // 一个根里只装这一个包，目录名 = 包 id
  // 大包（几百条告警级）在 Actions 上实测会顶到 300 s ⇒ 崩溃被误记成「包的问题」。
  // 给到 15 分钟，并把 stderr 留下，崩了也要能看出是超时还是判据。
  const v = spawnSync(process.execPath, [path.join(ROOT, 'tools/workshop-validate.mjs'), root, '--json'],
    { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL', windowsHide: true });
  const so = String(v.stdout ?? '');
  const se = String(v.stderr ?? '');
  let rep = null;
  try { rep = JSON.parse(so); } catch { /* 下面按崩溃记 */ }
  if (!rep) {
    rec.stage = v.signal === 'SIGKILL' ? 'VALIDATOR_TIMEOUT' : 'VALIDATOR_CRASH';
    // 崩溃/超时档位必须留下**可机读的现场**：两次口径相同却一绿一红的平台差异，只靠「崩溃」二字无法定位。
    // 体量（区分截断 vs 空输出）、spawn 级错误（区分 ENOBUFS 一类的启动失败）、两口尾部（区分半截 JSON vs
    // 杂讯）都写进 note，并把两口原文落盘随 artifact 上传（见 pack-compat.yml）。
    const spawnErr = v.error ? ` spawn=${v.error.code ?? v.error.message}` : '';
    rec.notes.push(`signal=${v.signal ?? '-'} status=${v.status} stdout=${so.length}B stderr=${se.length}B${spawnErr}`);
    rec.notes.push(`stdout-tail: ${so.slice(-240).replace(/\s+/g, ' ')}`);
    rec.notes.push(`stderr-tail: ${se.slice(-240).replace(/\s+/g, ' ')}`);
    try {
      fs.writeFileSync(path.join(WORK, `${m.id}.stdout.txt`), so);
      fs.writeFileSync(path.join(WORK, `${m.id}.stderr.txt`), se);
    } catch { /* 现场落盘失败不影响判定 */ }
    rows.push(rec); console.log(`✗ ${m.id} 校验器${v.signal === 'SIGKILL' ? '超时(900s)' : '崩溃'}（stdout=${so.length}B stderr=${se.length}B）`); continue;
  }
  rec.stage = v.status === 0 ? 'VALID' : (v.status === 1 ? 'REJECTED' : `EXIT_${v.status}`);
  rec.errors = rep.errorCount ?? rep.errors ?? 0;
  rec.warnings = rep.warningCount ?? rep.warnings ?? 0;
  const codes = [];
  // 报告形状（实测）：errors/warnings 是**计数**，明细只在 packs[].issues[]，条目形如 {code, severity, message}
  for (const p of rep.packs ?? []) for (const it of p.issues ?? []) if (it.severity !== 'warn') codes.push(it.code ?? String(it.message).slice(0, 40));
  rec.codes = [...new Set(codes.filter(Boolean))].slice(0, 8);
  rec.packIdFromJson = pid;
  rows.push(rec);
  console.log(`${rec.stage === 'VALID' ? '✔' : '✗'} ${m.id} ${pid.padEnd(26)} ${rec.stage} err=${rec.errors} warn=${rec.warnings} [${rec.codes.join(',')}] ${String(m.name).slice(0, 26)}`);
}

fs.writeFileSync(path.join(WORK, 'report.json'), JSON.stringify(rows, null, 1));
const tally = {};
for (const x of rows) tally[x.stage] = (tally[x.stage] ?? 0) + 1;
const bad = rows.filter((x) => ['REJECTED', 'ZIP_REFUSED', 'VALIDATOR_CRASH', 'TRUNCATED_DOWNLOAD', 'BAD_PACK_ID'].includes(x.stage));
const mine = bad.filter(isMine);
const transport = rows.filter((x) => x.stage === 'TRUNCATED_DOWNLOAD');
console.log('汇总:', JSON.stringify(tally));
if (transport.length) console.log(`⚠ ${transport.length} 条**下载不完整**：这些不出兼容性结论（不代表兼容，也不代表不兼容）`);

const md = ['### 线上包 × 本引擎 兼容性', `- 引擎：本仓 checkout（` + spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim() + '）',
  `- 清单可见 mods ${mods.length} + flagged ${flagged.length} = ${all.length}，本轮判定 ${target.length}，成判 ${rows.length}`,
  `- 结果：${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
  bad.length ? `\n不通过/异常（第三方只报告，不拦）：\n\n| id | src | stage | codes | 名称 | 作者 |\n|---|---|---|---|---|---|\n`
    + bad.slice(0, 40).map((x) => `| ${x.id} | ${x.src ?? '-'} | ${x.stage} | ${x.codes.join(',')} | ${String(x.name).slice(0, 28)} | ${x.compatAuthor || x.author || '-'} |`).join('\n') : ''];
const dest = process.env.GITHUB_STEP_SUMMARY;
if (dest) fs.appendFileSync(dest, md.filter(Boolean).join('\n') + '\n');

if (!rows.length) { console.error('::error::一条都没判成（这不等于兼容）'); process.exit(2); }
if (transport.length) { console.error(`::error::${transport.length} 条下载不完整 ⇒ 兼容性结论**未定**，不许报绿（这不是「包不兼容」，是传输问题）`); process.exit(1); }
if (mine.length) { console.error(`::error::**我方**有 ${mine.length} 条包在本引擎上不通过：${mine.map((x) => x.id + ':' + x.stage + '[' + x.codes.join('|') + ']').join(', ')}`); process.exit(1); }
console.log(`✓ 我方包没有新增不兼容（第三方不通过/异常 ${bad.length} 条只作报告；其中来自 flagged 的 ${bad.filter((x) => x.src === 'flagged').length} 条）`);
