// test/modxiePackLoads.test.mjs — 兼容性验收：管理器（Forge 0.13.0 管理器树）能**完整装载** `mod-xie/` 这个工坊包，
// 一条拒绝都没有；通道声明在两个半边（面板 messages / 模块 channels）里对上。
//
// 为什么这一条值得单独一个文件：pack.json 的形状、面板模块必须在包里、模块要能 import、`registerServer` 要存在、
// 通道必须被面板声明过 —— 这些判据分散在 `loadWorkshop` / `loadServerModules` / `loadWorkshopPanels` 三个装载器里，
// 而「包能被管理器接受」正是本次改造的验收标准。跑法（在管理器树根）：
//   node --test test/modxiePackLoads.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_SRC = path.join(ROOT, 'mod-xie');

test('安装 = 复制进 workshop/：管理器装载零拒绝，通道两半边对上', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-modxie-'));
  try {
    // 「安装」就是这一行：包目录名必须是 id（装载器的硬约束）
    fs.cpSync(PACK_SRC, path.join(tmp, 'mod-xie'), { recursive: true });

    const { loadWorkshop, loadWorkshopPanels } = await import(pathToFileURL(path.join(ROOT, 'server', 'workshop.js')).href);
    const { loadServerModules } = await import(pathToFileURL(path.join(ROOT, 'server', 'modModules.js')).href);

    const loaded = loadWorkshop(tmp, { log: null });
    assert.deepEqual(loaded.errors, [], `装载器一条拒绝都不该有：${JSON.stringify(loaded.errors)}`);
    assert.equal(loaded.packs.length, 1);
    const pack = loaded.packs[0];
    assert.equal(pack.id, 'mod-xie');
    assert.equal(pack.combat, true, '声明了 combat:true（matchClass 的硬闸门）');
    // v2.1：server.modules[].channels **不是引擎字段**（闭集是 id/entry/uses/write —— 写了整包
    // 被 MODULES_UNKNOWN_FIELD 点名拒绝），引擎的投递白名单只认面板的 `messages`（server/lobby.js packChannels）。
    assert.deepEqual(pack.server.modules[0].uses, ['matchClass'], '模块只声明它真正碰到的那一层');
    assert.equal(pack.server.modules[0].channels, undefined, '不写引擎不认识的字段');
    const messages = [...pack.client.panels[0].messages].sort();
    assert.deepEqual(messages, ['answer', 'borrow', 'project', 'relief', 'revive', 'vote'], '面板声明的通道（6 个）');

    const modules = await loadServerModules({ packs: loaded.packs }, { stateRoot: tmp, log: null });
    assert.deepEqual(modules.errors, [], `服务端模块要能装载：${JSON.stringify(modules.errors)}`);

    const panels = loadWorkshopPanels(loaded, { log: null });
    assert.deepEqual(panels.errors ?? [], [], `面板要能装载：${JSON.stringify(panels.errors ?? [])}`);
    assert.equal(panels.panels.length, 1);
    assert.equal(panels.panels[0].pack, 'mod-xie');
    assert.equal(panels.panels[0].slot, 'screen.game.hud');
    assert.deepEqual([...panels.panels[0].messages].sort(), messages, '面板的声明与投递白名单是同一批名字');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('包是自足的：服务端代码不 import 包外的任何模块', () => {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.(m?js)$/.test(ent.name)) files.push(abs);
    }
  };
  walk(path.join(PACK_SRC, 'server'));
  files.push(path.join(PACK_SRC, 'client', 'econ.js'));
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|[;}\s])((?:import|export)\s[\s\S]*?\sfrom\s*(['"])([^'"\n]+)\2)/g)) {
      const spec = m[3];
      if (!spec.startsWith('./') && !spec.startsWith('../')) { offenders.push(`${path.relative(PACK_SRC, file)} → ${spec}`); continue; }
      // 相对路径必须仍落在包内
      const target = path.resolve(path.dirname(file), spec);
      if (path.relative(PACK_SRC, target).startsWith('..')) offenders.push(`${path.relative(PACK_SRC, file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], '一个爬出包目录的 import 都不该有（面板模块更是零 import）');
});
