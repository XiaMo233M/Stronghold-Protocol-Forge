#!/usr/bin/env node
// scripts/make-voice-pack.mjs — 打「多语言配音包」：把 public/assets/audio/voice/ 下**除默认配音外**的语言目录打成一个 zip，
// 作为 release 的附加资产发布（v0.7.2）。主包只带默认配音（清单 audio.voiceLang，一般是 cn），四种配音全塞进去要多
// ≈196 MB，所以其余语言单独下。
//
//   node scripts/make-voice-pack.mjs [--out <zip>] [--langs=jp,en,kr] [--include-default] [--force]
//
// 产物内容（解压到游戏目录即可，不需要改任何配置）：
//   voice/<lang>/<charId>/cn_0NN.mp3 …   直接覆盖到 app\public\assets\audio\voice\
//   装语音包-说明.md                      给玩家看的两步说明
//
// 为什么不用改配置：`data/assets.json` 里 `audio.voiceLangs` 早就列好了这些语言（包体里只是缺文件），客户端在选中
// 未安装的配音时会回退到默认配音（public/js/audio.js voiceLinesFor / _playVoice），所以装上就有、没装也能玩。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOICE_ROOT = path.join(ROOT, 'public', 'assets', 'audio', 'voice');
const MB = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

const HELP = `node scripts/make-voice-pack.mjs — 打多语言配音包（release 附加资产）

  --out <zip>          产物路径（默认 <仓库上一级>/Stronghold-Protocol-Forge-<版本>-voices.zip）
  --langs=jp,en,kr     要装进包的语言（默认：voice/ 下除默认配音外的全部）
  --include-default    连默认配音（cn）也一起装进去
  --force              产物已存在时覆盖
`;

function parseArgs(argv) {
  const o = { out: '', langs: null, includeDefault: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, v] = a.split('=');
    const val = () => (v !== undefined ? v : argv[++i]);
    if (k === '--out') o.out = String(val() || '');
    else if (k === '--langs') o.langs = String(val() || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--include-default') o.includeDefault = true;
    else if (a === '--force') o.force = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}\n${HELP}`);
  }
  return o;
}

const listDubs = () => {
  try { return fs.readdirSync(VOICE_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); }
  catch { return []; }
};

const defaultDub = () => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
    return typeof m?.audio?.voiceLang === 'string' && m.audio.voiceLang ? m.audio.voiceLang : 'cn';
  } catch { return 'cn'; }
};

const version = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
};

/** Every file of one dub as `<lang>/<charId>/<file>`, with its byte size. */
function dubFiles(lang) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else if (e.isFile()) out.push({ rel: `voice/${rel}/${e.name}`, abs: p, size: fs.statSync(p).size });
    }
  };
  const dir = path.join(VOICE_ROOT, lang);
  if (fs.existsSync(dir)) walk(dir, lang);
  return out;
}

const README = `# 多语言配音包

这个包里是《卫戍协议：Forge》的**额外干员配音**（主包只带默认配音）。安装只有两步：

1. 解压，得到 \`voice/\` 文件夹；
2. 把 \`voice/\` 覆盖到游戏的 \`app\\public\\assets\\audio\\voice\\\`（和已有的 \`voice/\` 合并，同名文件覆盖即可）。

装好后**不需要改任何配置**：游戏清单里本来就列着这些语言，进游戏后
\`设置 → 配音语言\` 选全局默认，任何干员的 \`干员详情 → 配音\` 还能单独换一种（点一下当场试听）。

没装这个包也能玩：选了未安装的配音时，游戏会自动用默认配音的那一句，不会变成没声音
（设置里也会标明哪几种配音没装）。素材版权归上海鹰角网络 / Yostar，**仅限非商业使用**。
`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return 0; }
  const dubs = listDubs();
  const def = defaultDub();
  const wanted = (o.langs || dubs.filter((l) => o.includeDefault || l !== def)).filter((l) => dubs.includes(l));
  if (!wanted.length) {
    console.error(`[voice-pack] public/assets/audio/voice 下没有可打包的语言（现有：${dubs.join(', ') || '空'}）`);
    return 1;
  }
  const out = o.out
    ? path.resolve(o.out)
    : path.join(path.dirname(ROOT), `Stronghold-Protocol-Forge-${version()}-voices-${wanted.join('-')}.zip`);
  if (fs.existsSync(out) && !o.force) { console.error(`[voice-pack] ${out} 已存在（--force 覆盖）`); return 1; }

  // 用 Node 自带能力打 zip：仓库没有第三方 zip 依赖，PowerShell 的 Compress-Archive 在非 Windows 上不可用，
  // 所以先把待打包目录聚到一个临时 stage 目录，再用平台自带的归档命令。
  const stage = await fsp.mkdtemp(path.join(ROOT, '.cache', 'voice-pack-'));
  try {
    let files = 0; let bytes = 0;
    await fsp.writeFile(path.join(stage, '装语音包-说明.md'), README, 'utf8');
    for (const lang of wanted) {
      for (const f of dubFiles(lang)) {
        const to = path.join(stage, f.rel);
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(f.abs, to);
        files++; bytes += f.size;
      }
    }
    fs.rmSync(out, { force: true });
    const r = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`],
        { stdio: 'inherit' })
      : spawnSync('zip', ['-qr', out, '.'], { cwd: stage, stdio: 'inherit' });
    if (r.status !== 0) { console.error('[voice-pack] 归档失败'); return 1; }
    const size = fs.statSync(out).size;
    console.log(`✔ 配音包已生成：${out}`);
    console.log(`  语言 ${wanted.join(' / ')}（默认配音 ${def}）· ${files} 个文件 / ${MB(bytes)} → zip ${MB(size)}`);
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

const invoked = (() => { try { return new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url; } catch { return false; } })();
if (invoked) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`[voice-pack] FAILED: ${process.env.DEBUG ? e?.stack || e : e?.message || e}`);
    process.exitCode = 1;
  });
}
