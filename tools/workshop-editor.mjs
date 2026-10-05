#!/usr/bin/env node
// tools/workshop-editor.mjs — start the standalone 工坊编辑器 (docs/EDITOR.md).
//
// This file IS the distribution model: the editor is an OPTION. The game server never mentions it, the game client
// never loads it (`editor/` sits outside `public/`, so server/index.js cannot even serve it), and nothing here runs
// unless someone asks for it. Ship the repository and run:
//
//     node tools/workshop-editor.mjs
//
// Usage:
//   node tools/workshop-editor.mjs [--port 3311] [--host 127.0.0.1] [--workshop <root>] [--open]
//
// It binds 127.0.0.1 by default ON PURPOSE: the editor can write packs and data/support.json, so exposing it on a LAN
// is an explicit decision. --host 0.0.0.0 prints a warning and is never the default.
//
// Exit codes: 0 = stopped, 2 = bad usage / could not start.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { createEditorServer, EDITOR_ROOT } from '../editor/server.mjs';
import { loadWorkshop, WORKSHOP_DIR } from '../server/workshop.js';

const DEFAULT_PORT = 3311;
const USAGE = 'usage: node tools/workshop-editor.mjs [--port 3311] [--host 127.0.0.1] [--workshop <root>] [--open]';

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, host: '127.0.0.1', workshop: WORKSHOP_DIR, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--port') { out.port = Number(val()); if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0..65535'); }
    else if (a === '--host') out.host = val();
    else if (a === '--workshop') out.workshop = path.resolve(val());
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!LOOPBACK.has(args.host)) {
    console.log('');
    console.log('  ⚠ 正在把编辑器绑定到非本机地址：' + args.host);
    console.log('    编辑器可以写入工坊包和 data/support.json。除非你清楚风险，否则请用 --host 127.0.0.1。');
    console.log('');
  }
  const srv = await createEditorServer({ workshopRoot: args.workshop, host: args.host, port: args.port });
  const loaded = loadWorkshop(args.workshop, { log: { warn() {}, info() {}, error() {} } });
  console.log(`工坊编辑器已启动: ${srv.url}`);
  console.log(`  工坊目录: ${args.workshop}`);
  console.log(`  已加载工坊包: ${loaded.packs.length ? loaded.packs.map((p) => p.id).join(', ') : '（无，可在界面里新建）'}`);
  if (loaded.errors.length) for (const e of loaded.errors) console.log(`  ⚠ ${e.pack}: ${e.reason}`);
  console.log('  编辑内容重启游戏服务器后生效。按 Ctrl+C 停止。');
  if (args.open) {
    const url = srv.url;
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* opening is best-effort */ }
  }
  const stop = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return srv;
}

main().catch((e) => {
  console.error(`workshop-editor: ${e.message}`);
  console.error(USAGE);
  process.exit(2);
});

export { EDITOR_ROOT };
