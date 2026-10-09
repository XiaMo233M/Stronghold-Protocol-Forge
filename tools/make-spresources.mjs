// tools/make-spresources.mjs — 产出一个工坊包自带的资源容器（DESIGN §28.13.5，docs/WORKSHOP.md §1.9.4）。
//
// 一件工具，三个产物，都落在**包目录**里（参考项目是「一个全局资源集 + 四个产物」，本仓是「每个包自带一份」，
// 差别写进 tools/spresources.mjs 的来源说明）：
//
//   <pack>/packs/resources-<version>.spresources          容器本体（`pack.json.assets.container` 指向它）
//   <pack>/packs/resources-<version>.spresources.sha256   旁挂摘要 `<64 hex>  <文件名>\n`（`assets.verify: "sha256"` 读它）
//   <pack>/resource-manifest.json                         权威清单（`assets.manifest` 指向它；客户端拿它逐文件校验）
//
// **格式一个字节都不在这里决定**：字节布局、清单形状、版本算法全部来自 `tools/spresources.mjs`（逐字节验证过的
// 那个复刻件）。本文件只是「我们的产物布局」那一层胶水，并且与参考写入器 `buildPack` 有**逐字节相同**的断言
// （`test/modAssets.test.js`）。
//
// 清单必须**显式给**（`--manifest`）：参考实现的按磁盘枚举自带一套退化的 tier 规则（除 fonts 全 tier2），
// 用它会得到「首屏什么素材都没有」的包（`_up/mod4-resource-pack-recon.md` §3.8 坑①）。tier 是**内容判断**，
// 只能由知道素材语义的一方给。
//
// 用法：
//   node tools/make-spresources.mjs --manifest <清单.json> --public <素材根> --out <包目录> [--name <基名>]
//        [--manifest-out <包内清单名>] [--qq-group <号>] [--force]
//
// 退出码：0 成功，1 失败（拒绝覆盖 / 清单与源字节对不上 / 参数不全 —— 都打印一条人能看懂的错）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  MAGIC, MAX_HEADER_BYTES, DEFAULT_QQ_GROUP,
  validateManifest, computeVersion, buildHeader, sha1_12, fileFor, prettyJson, platformEol,
} from './spresources.mjs';

const USAGE = 'usage: node tools/make-spresources.mjs --manifest <file.json> --public <dir> --out <pack dir>'
  + ' [--name <base>] [--manifest-out <name>] [--qq-group <number>] [--force]';

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { out.force = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    const key = a.slice(2);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
    out[key] = value;
  }
  return out;
}

/**
 * 写出容器 + 旁挂摘要 + 权威清单。
 * @param {{ manifestFile: string, publicDir: string, outDir: string, name?: string, manifestOut?: string,
 *   qqGroup?: string, force?: boolean, log?: (line: string) => void, eol?: 'lf'|'crlf' }} opts
 * @returns {{ pack: string, version: string, files: number, headerLen: number, bytes: number, sha256: string }}
 */
export function makePack(opts) {
  const log = opts.log || (() => {});
  const manifestFile = path.resolve(opts.manifestFile);
  const publicDir = path.resolve(opts.publicDir);
  const outDir = path.resolve(opts.outDir);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const eol = opts.eol === 'crlf' ? '\r\n' : opts.eol === 'lf' ? '\n' : platformEol();

  const shape = validateManifest(manifest);
  if (!shape.ok) throw new Error(`清单不合法：${shape.error}`);
  const recomputed = computeVersion(manifest.files);
  if (recomputed !== manifest.version) {
    throw new Error(`manifest.version (${manifest.version}) 与 sha256(压紧 files)[0:12] (${recomputed}) 不一致`
      + ' —— 版本号是清单自己算出来的，改过 files 就要重算（tools/make-spresources.mjs 不会替你猜）');
  }

  // ① 先核对**全部源字节**（写可分发字节之前）：大小与 SHA-1[0:12] 都要与清单一致。
  for (const entry of manifest.files) {
    const body = fs.readFileSync(fileFor(publicDir, entry.url));
    if (body.length !== entry.size || sha1_12(body) !== entry.hash) throw new Error(`源文件与清单不一致：${entry.url}`);
  }

  const header = buildHeader(manifest, opts.qqGroup || DEFAULT_QQ_GROUP);
  if (header.length > MAX_HEADER_BYTES) throw new Error('头 JSON 超过浏览器上限');
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  const expectBytes = 12 + header.length + total;

  const base = opts.name || `resources-${manifest.version}`;
  const packDir = path.join(outDir, 'packs');
  const target = path.join(packDir, `${base}.spresources`);
  const manifestOut = path.join(outDir, opts.manifestOut || 'resource-manifest.json');
  const outputs = [target, `${target}.sha256`, manifestOut];
  const existing = outputs.filter((f) => fs.existsSync(f));
  if (existing.length && !opts.force) {
    throw new Error(`拒绝覆盖已存在的产物（${existing.length} 个）：\n  ${existing.join('\n  ')}\n（要覆盖请显式加 --force）`);
  }
  fs.mkdirSync(packDir, { recursive: true });

  // ② 写容器：magic + uint32LE 头长 + 压紧头 JSON + 按清单顺序原样拼接的文件体；同步累加整包 SHA-256。
  const whole = crypto.createHash('sha256');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(header.length, 8);
  const fd = fs.openSync(target, 'w');
  try {
    fs.writeSync(fd, prefix);
    whole.update(prefix);
    fs.writeSync(fd, header);
    whole.update(header);
    for (const entry of manifest.files) {
      const body = fs.readFileSync(fileFor(publicDir, entry.url));
      // 写包期间源又被改了：与参考实现一样当场拒绝，而不是产出一个坏包。
      if (body.length !== entry.size || sha1_12(body) !== entry.hash) throw new Error(`打包期间源文件变了：${entry.url}`);
      fs.writeSync(fd, body);
      whole.update(body);
    }
  } finally {
    fs.closeSync(fd);
  }
  const stat = fs.statSync(target);
  if (stat.size !== expectBytes) {
    throw new Error(`内部错误：写出 ${stat.size} 字节，应为 12 + ${header.length} + ${total} = ${expectBytes}`);
  }
  const digest = whole.digest('hex');

  // ③ 旁挂摘要与权威清单。行尾跟随平台（参考实现写这些文本文件时走的是 Python 的文本模式）。
  const writeText = (file, text) => fs.writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8');
  writeText(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`);
  writeText(manifestOut, `${prettyJson(manifest)}\n`);

  log(`[spresources] ${path.relative(process.cwd(), target)} · ${manifest.files.length} 文件 · ${stat.size} 字节 · sha256=${digest}`);
  return { pack: target, version: manifest.version, files: manifest.files.length, headerLen: header.length, bytes: stat.size, sha256: digest };
}

export function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    console.error(`spresources: ${e.message}\n${USAGE}`);
    return 1;
  }
  if (args.help) { console.log(USAGE); return 0; }
  for (const required of ['manifest', 'public', 'out']) {
    if (!args[required]) { console.error(`spresources: --${required} is required\n${USAGE}`); return 1; }
  }
  try {
    makePack({
      manifestFile: String(args.manifest), publicDir: String(args.public), outDir: String(args.out),
      name: args.name ? String(args.name) : undefined,
      manifestOut: args['manifest-out'] ? String(args['manifest-out']) : undefined,
      qqGroup: args['qq-group'] ? String(args['qq-group']) : undefined,
      force: args.force === true, log: (line) => console.log(line),
    });
    return 0;
  } catch (e) {
    console.error(`spresources: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) process.exit(main(process.argv.slice(2)));
