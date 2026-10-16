// test/windows-bundle.test.js — Windows 便携包脚本里那几处「写错就会毁掉一次打包」的纯函数。
//
// 打包本身要联网下载官方 Node、还要 `npm ci`，不适合放进单元测试；这里盯住这些：
//   * `--out` 指向仓库自己或它的上级时，`--force` 会 `rm -rf` 掉仓库 —— 必须直接拒绝；
//   * 路径比较要经得起大小写（Windows / macOS 默认不区分）、符号链接、8.3 短名；
//   * `--force` 只肯删「空目录」或「上一次打的便携包」，认不出来就不许动；
//   * 素材是整树复制的，点开头的条目（打包机器的 .DS_Store）与符号链接不该跟着进包；
//   * 按清单复制时，缺失的源文件跳过而不是抛错（素材可能还没下载）；
//   * **工作区必须干净**：文件名清单来自 `git ls-files`（已提交的树），内容却从**工作区磁盘**读 ——
//     有未提交改动时包里装的就是「tag 指向的树里没有的那份内容」，而旧实现没有任何守卫会拦（发布时真踩到过）；
//   * 包内说明的措辞：不能声称「不访问外网」（Google Fonts 外链没改），`--no-node` 时也不能说不用装 Node。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

describe('make-windows-bundle.mjs: --out 不能指向仓库自己或它的上级', () => {
  test('仓库本身与它的上级目录都要拒绝', async () => {
    const { outDirIsUnsafe } = await mod('scripts/make-windows-bundle.mjs');
    assert.equal(outDirIsUnsafe(ROOT), true, '仓库本身');
    assert.equal(outDirIsUnsafe(path.dirname(ROOT)), true, '仓库的上一级');
    assert.equal(outDirIsUnsafe(path.resolve(path.dirname(ROOT), '..')), true, '再上一级');
    assert.equal(outDirIsUnsafe(path.join(ROOT, '..', path.basename(ROOT))), true, '写成 .. 绕一圈也还是仓库自己');
  });

  test('仓库之外的目录放行（默认产物就是仓库的兄弟目录）', async () => {
    const { outDirIsUnsafe } = await mod('scripts/make-windows-bundle.mjs');
    assert.equal(outDirIsUnsafe(path.join(path.dirname(ROOT), 'Stronghold-Protocol-Windows')), false, '默认产物位置');
    assert.equal(outDirIsUnsafe(path.join(os.tmpdir(), 'sp-bundle-out')), false, '临时目录');
    // 指向仓库**内部**是允许的：只是产物会出现在 git status 里，不会删掉仓库。
    assert.equal(outDirIsUnsafe(path.join(ROOT, 'dist-win')), false, '仓库内的子目录');
  });

  test('大小写不同也算同一个目录（Windows / macOS 的文件系统默认不区分大小写）', async (t) => {
    const { outDirIsUnsafe } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-case-'));
    t.after(() => fsp.rm(base, { recursive: true, force: true }));
    const root = path.join(base, 'Stronghold-Protocol');
    await fsp.mkdir(root);
    // Linux 的默认文件系统区分大小写：`/HOME/X` 就是另一个目录，放行才对。
    const sameThing = process.platform !== 'linux';
    assert.equal(outDirIsUnsafe(root, root), true, '原路径');
    assert.equal(outDirIsUnsafe(path.join(base, 'STRONGHOLD-PROTOCOL'), root), sameThing, '全大写写法');
    assert.equal(outDirIsUnsafe(path.join(base, 'stronghold-protocol'), root), sameThing, '全小写写法');
  });

  test('经过符号链接的路径会被认出来（macOS 的 /tmp 就是指向 /private/tmp 的链接）', async () => {
    const { outDirIsUnsafe } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-link-'));
    try {
      const real = path.join(base, 'real', 'Stronghold-Protocol');
      await fsp.mkdir(real, { recursive: true });
      const link = path.join(base, 'link');
      try {
        // Windows 上目录符号链接要管理员权限，junction 不用；其它平台用 dir。
        await fsp.symlink(path.join(base, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;   // 建不出链接的环境（缺权限 / 缺支持）就跳过这一条
      }
      assert.equal(outDirIsUnsafe(path.join(link, 'Stronghold-Protocol'), real), true,
        '同一个目录，一条路径经过符号链接也要认出来');
      assert.equal(outDirIsUnsafe(path.join(link, 'Stronghold-Protocol', 'dist'), real), false, '仓库内部仍然放行');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});

describe('make-windows-bundle.mjs: --force 只肯删空目录或上一次的包', () => {
  test('不存在 / 空目录 / 上一次打的包 → 可以删', async () => {
    const { forceDeleteVerdict } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-force-'));
    try {
      assert.equal(forceDeleteVerdict(path.join(base, 'nope')), 'missing');

      const empty = path.join(base, 'empty');
      await fsp.mkdir(empty);
      assert.equal(forceDeleteVerdict(empty), 'empty');

      const bundle = path.join(base, 'bundle');
      await fsp.mkdir(path.join(bundle, 'app'), { recursive: true });
      await fsp.writeFile(path.join(bundle, 'README-开箱即用.md'), '# x');
      await fsp.writeFile(path.join(bundle, 'LICENSE'), 'x');
      assert.equal(forceDeleteVerdict(bundle), 'bundle');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test('有东西但不是上次的包 → 一律拒绝（包括桌面、仓库、只有半份的产物）', async () => {
    const { forceDeleteVerdict } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-force2-'));
    try {
      const desktop = path.join(base, 'Desktop');
      await fsp.mkdir(desktop);
      await fsp.writeFile(path.join(desktop, '重要文件.txt'), 'x');
      assert.equal(forceDeleteVerdict(desktop), 'refuse', '别人的目录不能删');

      assert.equal(forceDeleteVerdict(ROOT), 'refuse', '仓库根不是便携包');
      assert.equal(forceDeleteVerdict(path.dirname(ROOT)), 'refuse', '仓库的上级也不是');

      const half = path.join(base, 'half');
      await fsp.mkdir(path.join(half, 'app'), { recursive: true });
      assert.equal(forceDeleteVerdict(half), 'refuse', '只有 app 没有说明：可能是别人的目录，不删');
      const half2 = path.join(base, 'half2');
      await fsp.mkdir(half2);
      await fsp.writeFile(path.join(half2, 'README-开箱即用.md'), '# x');
      assert.equal(forceDeleteVerdict(half2), 'refuse', '只有说明没有 app：同样不删');

      const file = path.join(base, 'afile');
      await fsp.writeFile(file, 'x');
      assert.equal(forceDeleteVerdict(file), 'refuse', '同名文件不是目录，不删');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});

describe('make-windows-bundle.mjs: 包内说明的措辞', () => {
  test('不再声称「不访问外网」，改成联网 / 断网两种情况都讲清', async () => {
    const { bundleReadme } = await mod('scripts/make-windows-bundle.mjs');
    const r = bundleReadme({ version: 'v22.23.3', withNode: true });
    assert.ok(!/不访问外网/.test(r), 'index.html 的 Google Fonts 外链没改，不能说这个包不访问外网');
    assert.match(r, /不联网也能玩/, '断网可用要写清楚');
    assert.match(r, /Google Fonts/, '联网时会去 Google Fonts 加载字体，要如实说明');
    assert.match(r, /断网/, '断网时的回退也要写');
    assert.match(r, /不需要安装 Node/);
    assert.match(r, /node\\node\.exe/);
  });

  test('每条授权要点都在（素材归原权利人 / 不适用 GPL / 不单独再分发 / 可要求删除 / 无担保）', async () => {
    const { bundleReadme } = await mod('scripts/make-windows-bundle.mjs');
    for (const withNode of [true, false]) {
      const r = bundleReadme({ version: 'v22.23.3', withNode });
      assert.match(r, /版权归原权利人所有/, `withNode=${withNode}`);
      assert.match(r, /不适用.*GPL/, `withNode=${withNode}`);
      assert.match(r, /单独再分发/, `withNode=${withNode}`);
      assert.match(r, /立即删除/, `withNode=${withNode}`);
      assert.match(r, /不提供任何担保/, `withNode=${withNode}`);
      assert.match(r, /严禁任何形式的盈利/, `withNode=${withNode}`);
      assert.ok(!/本包按 GPL/.test(r), `withNode=${withNode}: 不能写「本包按 GPL-3.0-or-later 分发」`);
    }
  });

  test('--no-node 时不再写「不需要安装 Node」，目录结构也不列 node\\', async () => {
    const { bundleReadme } = await mod('scripts/make-windows-bundle.mjs');
    const r = bundleReadme({ version: 'v22.23.3', withNode: false });
    assert.ok(!/不需要安装 Node/.test(r), '没带便携 Node 就不能说不用装');
    assert.match(r, /没有带便携版 Node/, '要明确告诉玩家自己去装 Node 22/24');
    assert.ok(!/node\\node\.exe/.test(r), '目录结构里不该出现 node.exe');
    assert.ok(!/LICENSE-node\.txt/.test(r), '也不该提 node\\LICENSE-node.txt');
  });

  test('角色语音：只有真的打进包里才说，并且说明音量在哪里调', async () => {
    const { bundleReadme } = await mod('scripts/make-windows-bundle.mjs');
    // 0.2.0 起语音随素材一起抓（tools/assets/audio.mjs 默认就规划），所以「包里有语音」仍是打包时的事实，不能无条件写
    const without = bundleReadme({ version: 'v22.23.3', withNode: true });
    assert.ok(!/角色语音台词/.test(without), '没抓语音的 checkout 不能声称包里带语音');
    const withVoices = bundleReadme({ version: 'v22.23.3', withNode: true, withVoices: true });
    assert.match(withVoices, /角色语音台词已经在包里/);
    assert.match(withVoices, /干员语音（VOICE）/, '要告诉玩家去哪里调');
    assert.match(withVoices, /默认 0\.8/, '0.2.0 起干员语音默认 0.8 = 开，这一点必须写对');
    assert.match(withVoices, /WORKSHOP\.md/, '工坊包自带语音走同一条链路，指一下文档');
    // 多语言配音: a bundle that carries several dubs says so (and where to switch); one dub + a voice pack must point at
    // the pack instead of promising a language switch, and must never advertise a dub it does not carry
    assert.ok(!/配音语言/.test(withVoices), '一种配音时不吹多语言');
    const multi = bundleReadme({ version: 'v22.23.3', withNode: true, withVoices: true, voiceLangs: ['cn', 'jp', 'en', 'kr'] });
    assert.match(multi, /4 种配音都在包里/);
    assert.match(multi, /设置 → 配音语言/);
    assert.match(multi, /干员详情 → 配音/);
    const packed = bundleReadme({ version: 'v22.23.3', withNode: true, withVoices: true, voiceLangs: ['cn'], voicePackLangs: ['jp', 'en', 'kr'] });
    assert.match(packed, /包里只有一种配音/);
    assert.match(packed, /-voices-\*?\.zip/, 'the voice pack asset is named');
    assert.match(packed, /app\\public\\assets\\audio\\voice\\/, 'the install target is spelled out');
    assert.ok(!/4 种配音都在包里/.test(packed), 'the dubs it does not carry are not promised');
  });
});

describe('make-windows-bundle.mjs: PowerShell 单引号转义', () => {
  test("路径里的 ' 要写成 ''（否则 Expand-Archive 那条命令会被截断）", async () => {
    const { psSingleQuote } = await mod('scripts/make-windows-bundle.mjs');
    assert.equal(psSingleQuote('C:\\tmp\\node.zip'), "'C:\\tmp\\node.zip'");
    assert.equal(psSingleQuote("C:\\it's here\\node.zip"), "'C:\\it''s here\\node.zip'");
    assert.equal(psSingleQuote("a'b'c"), "'a''b''c'");
  });
});

describe('make-windows-bundle.mjs: 包根的双击入口（游戏 + 编辑器 + 安装工坊包）', () => {
  test('三个 .bat 都在，且各自指向正确的入口', async () => {
    const { bundleLaunchers } = await mod('scripts/make-windows-bundle.mjs');
    const l = bundleLaunchers();
    assert.deepEqual(Object.keys(l).sort(), ['安装工坊包.bat', '启动编辑器.bat', '启动游戏.bat'].sort(),
      '本仓库是 Forge：编辑器必须有它自己的入口；没有编辑器的玩家也要能装包');
    assert.match(l['启动游戏.bat'], /app\\scripts\\launch\.mjs/, '游戏走 scripts/launch.mjs');
    assert.match(l['启动游戏.bat'], /--no-setup/, '素材已在包内，不再跑 setup');
    assert.match(l['启动编辑器.bat'], /app\\tools\\workshop-editor\.mjs/, '编辑器走 tools/workshop-editor.mjs');
    assert.match(l['启动编辑器.bat'], /--open\b/, '双击就该看见界面');
    assert.ok(!/--no-setup/.test(l['启动编辑器.bat']), '编辑器不碰素材，没有 setup 这回事');
    assert.match(l['安装工坊包.bat'], /app\\tools\\workshop-pack\.mjs"? import %\*/, '安装包走 CLI 的 import，参数透传（拖进来的 .zip）');
  });

  test('三个入口都优先用包内便携 Node，并带上命令行参数，结束码非 0 时暂停', async () => {
    const { bundleLaunchers, bat } = await mod('scripts/make-windows-bundle.mjs');
    const text = Object.values(bundleLaunchers()).map((body) => bat(body)).join('\n');
    assert.match(text, /%HERE%node\\node\.exe/, '先找包内 node.exe');
    assert.match(text, /set "NODE=node"/, '没有便携 Node 时退回 PATH 上的 node');
    assert.match(text, /%\*/, '透传参数（换端口 / 换工坊目录 / 拖进来的 .zip 路径）');
    assert.match(text, /if not "%CODE%"=="0" pause/, '失败时停住窗口，双击的人能看见错误');
    // 命令体保持纯 ASCII（中文只在文件名与 CLI 自己的输出里）：.bat 的编码随代码页走，混中文最容易变成乱码
    for (const [name, body] of Object.entries(bundleLaunchers())) {
      assert.ok(!/[\u4e00-\u9fff]/.test(body), `${name} 的命令体不该含中文`);
    }
  });

  test('包内说明写明编辑器入口、端口与「保存后要重启服务器」', async () => {
    const { bundleReadme } = await mod('scripts/make-windows-bundle.mjs');
    for (const withNode of [true, false]) {
      const r = bundleReadme({ version: 'v22.23.3', withNode });
      assert.match(r, /启动编辑器\.bat/, `withNode=${withNode}: 说明要给出编辑器入口`);
      assert.match(r, /127\.0\.0\.1:3311/, `withNode=${withNode}: 要写明默认地址`);
      assert.match(r, /重启游戏服务器/, `withNode=${withNode}: 保存后需重启服务器才生效`);
      assert.match(r, /app\\docs\\prompts/, `withNode=${withNode}: 官方 prompt 的位置`);
      assert.match(r, /app\\workshop/, `withNode=${withNode}: 只写 workshop/ 与 data/support.json`);
      assert.match(r, /启动编辑器\.bat --port 3400/, `withNode=${withNode}: 换端口的方式`);
      assert.match(r, /安装工坊包\.bat/, `withNode=${withNode}: 装包入口（拖放 .zip）`);
      assert.match(r, /app\\workshop\\/, `withNode=${withNode}: 要说明装到哪里`);
    }
  });
});

describe('仓库里的启动脚本：编辑器与游戏各一份，一键可用', () => {
  test('编辑器脚本（Windows / POSIX）都存在并调用 workshop-editor + --open', () => {
    const win = fs.readFileSync(path.join(ROOT, 'scripts/start-editor-windows.bat'), 'utf8');
    const sh = fs.readFileSync(path.join(ROOT, 'scripts/start-editor.sh'), 'utf8');
    for (const [name, t] of [['start-editor-windows.bat', win], ['start-editor.sh', sh]]) {
      assert.match(t, /tools[\\/]workshop-editor\.mjs/, `${name}: 调用编辑器入口`);
      assert.match(t, /--open/, `${name}: 打开浏览器`);
      assert.match(t, /node_modules[\\/]ws[\\/]package\.json/, `${name}: 首次运行装依赖`);
      assert.match(t, /%22|22/, `${name}: 检查 Node 版本`);
      assert.ok(!/launch\.mjs/.test(t), `${name}: 不该去启动游戏服务器`);
    }
    assert.match(win, /--port 3400/, '端口被占用时给出换端口的提示');
  });

  test('游戏脚本仍然是「一键开服」，两个脚本互不冒充', () => {
    const win = fs.readFileSync(path.join(ROOT, 'scripts/start-windows.bat'), 'utf8');
    const sh = fs.readFileSync(path.join(ROOT, 'scripts/start.sh'), 'utf8');
    for (const [name, t] of [['start-windows.bat', win], ['start.sh', sh]]) {
      assert.match(t, /scripts[\\/]launch\.mjs/, `${name}: 走游戏启动器`);
      assert.ok(!/workshop-editor/.test(t), `${name}: 不是编辑器脚本`);
    }
  });

  test('安装工坊包的脚本（Windows 拖放 / POSIX 命令行）都在，且都在用同一个 CLI', () => {
    const winPath = path.join(ROOT, 'scripts/install-workshop-pack.bat');
    const shPath = path.join(ROOT, 'scripts/install-workshop-pack.sh');
    assert.ok(fs.existsSync(winPath) && fs.existsSync(shPath), '两个平台各一份');
    const win = fs.readFileSync(winPath, 'utf8');
    const sh = fs.readFileSync(shPath, 'utf8');
    for (const [name, t] of [['install-workshop-pack.bat', win], ['install-workshop-pack.sh', sh]]) {
      assert.match(t, /tools[\\/]workshop-pack\.mjs/, `${name}: 走包管理 CLI（与编辑器的包管理页共用同一批函数）`);
      assert.match(t, /import/, `${name}: 装包就是 import`);
      // 装包只读 zip、只写 workshop/<packId>/，不需要 node_modules —— 别顺手加一步 npm ci 让人以为要装依赖
      assert.ok(!/npm (ci|install)/.test(t), `${name}: 不该要求安装依赖`);
      assert.ok(!/launch\.mjs|workshop-editor\.mjs/.test(t), `${name}: 不是开服 / 开编辑器的脚本`);
    }
    assert.match(win, /chcp 65001/, 'Windows 脚本要设代码页，中文提示才不会乱码');
    assert.match(win, /%~1|%\*/, '拖进来的 .zip 路径必须传下去');
    assert.match(sh, /"\$@"/, 'POSIX 侧参数原样传下去');
    // .bat 必须是 CRLF（LF 的 .bat 在 cmd 里对 goto/label 不可靠）；两者都不能有 BOM
    for (const [name, p] of [['.bat', winPath], ['.sh', shPath]]) {
      const buf = fs.readFileSync(p);
      assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${name}: 不能有 BOM`);
      if (name === '.bat') assert.ok(buf.includes(Buffer.from('\r\n')), '.bat 必须是 CRLF');
    }
  });
});

describe('make-windows-bundle.mjs: 素材整树复制', () => {
  test('copyDir 跳过点开头的条目（打包机器自己的 .DS_Store）与符号链接', async () => {
    const { copyDir } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-copydir-'));
    try {
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      await fsp.mkdir(path.join(src, 'sub', '.hidden'), { recursive: true });
      await fsp.writeFile(path.join(src, 'a.png'), 'a');
      await fsp.writeFile(path.join(src, '.DS_Store'), 'junk');
      await fsp.writeFile(path.join(src, 'sub', 'b.png'), 'bb');
      await fsp.writeFile(path.join(src, 'sub', '.keep'), 'junk');
      await fsp.writeFile(path.join(src, 'sub', '.hidden', 'c.png'), 'ccc');

      const r = await copyDir(src, dst);
      assert.equal(r.files, 2, '只数 a.png 与 sub/b.png');
      assert.equal(fs.existsSync(path.join(dst, 'a.png')), true);
      assert.equal(fs.existsSync(path.join(dst, 'sub', 'b.png')), true);
      assert.equal(fs.existsSync(path.join(dst, '.DS_Store')), false, '.DS_Store 不进包');
      assert.equal(fs.existsSync(path.join(dst, 'sub', '.keep')), false);
      assert.equal(fs.existsSync(path.join(dst, 'sub', '.hidden')), false, '点开头的目录整棵跳过');

      // 符号链接：Windows 上建链接需要权限，建不出来就跳过这条（复制逻辑本身仍然跳过链接）。
      let linked = false;
      try {
        await fsp.symlink(path.join(src, 'a.png'), path.join(src, 'link.png'));
        linked = true;
      } catch { /* 没有权限就算了 */ }
      if (linked) {
        const dst2 = path.join(base, 'dst2');
        await copyDir(src, dst2);
        assert.equal(fs.existsSync(path.join(dst2, 'link.png')), false, '符号链接不复制（目标可能指向仓库外）');
      }
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test('copyFiles 跳过不存在的文件，其余照常复制', async () => {
    const { copyFiles } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-copyfiles-'));
    try {
      const src = path.join(base, 'src');
      const dst = path.join(base, 'dst');
      await fsp.mkdir(path.join(src, 'data'), { recursive: true });
      await fsp.mkdir(path.join(src, 'server'), { recursive: true });
      await fsp.writeFile(path.join(src, 'server', 'index.js'), 'code');
      await fsp.writeFile(path.join(src, 'data', 'local-assets.json'), '{}');

      const r = await copyFiles(['server/index.js', 'data/local-assets.json', 'public/assets/missing.png'], dst, src);
      assert.equal(r.files, 2, '缺失的那个被跳过');
      assert.equal(fs.existsSync(path.join(dst, 'server', 'index.js')), true, '目录自动建出来');
      assert.equal(fs.existsSync(path.join(dst, 'data', 'local-assets.json')), true);
      assert.equal(fs.existsSync(path.join(dst, 'public')), false, '没有文件就不该建空目录');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});

describe('make-windows-bundle.mjs: 工作区必须干净（清单来自 git ls-files、内容来自工作区磁盘）', () => {
  /**
   * 造一个一次性的 git 仓库：出包守卫要在**脏**仓库上被证明会拦，不能拿真仓库当试验场。
   * @param {string} dir
   */
  const initRepo = (dir) => {
    const git = (...args) => {
      const r = childProcess.spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
  };

  test('干净 ⇒ 放行；脏 ⇒ 抛错，点名每一处改动、并写明「commit 或 stash」与放行开关', async () => {
    const { worktreeStatus, assertCleanWorktree } = await mod('scripts/make-windows-bundle.mjs');
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-dirtyguard-'));
    try {
      initRepo(base);
      assert.equal(worktreeStatus(base).clean, true, '刚提交完是干净的');
      assert.doesNotThrow(() => assertCleanWorktree({ root: base }), '干净工作区必须放行');

      // 改一个**受跟踪**的文件 —— 这正是发布时踩到的那一刀：清单里有它，内容却是未提交的那份。
      fs.writeFileSync(path.join(base, 'a.txt'), 'two\n');
      const st = worktreeStatus(base);
      assert.equal(st.clean, false, '改过受跟踪文件 ⇒ 不干净');
      assert.equal(st.entries.length, 1);
      assert.match(st.entries[0], /a\.txt/);

      let err = null;
      try { assertCleanWorktree({ root: base }); } catch (e) { err = e; }
      assert.ok(err, '脏工作区必须拒绝出包（抛错 ⇒ main 里变成 ✖ + 退出码 1）');
      assert.match(err.message, /未提交改动/);
      assert.match(err.message, /a\.txt/, '要点名到底哪一处改动，别只说「有改动」');
      assert.match(err.message, /commit|stash/, '要写明怎么办');
      assert.match(err.message, /allow-dirty/, '要写明放行开关');

      // 未跟踪的新文件同样算脏：它**进不了** app\（那个清单来自 git ls-files），却会让人以为「已经打进去了」。
      fs.writeFileSync(path.join(base, 'untracked.txt'), 'x\n');
      assert.equal(worktreeStatus(base).clean, false, '未跟踪文件也算脏');
      assert.equal(worktreeStatus(base).entries.length, 2);

      // 逃生开关：只有显式给了才放行，而且必须打出风险提示（不许静默放行）。
      const warned = [];
      const original = console.warn;
      console.warn = (...a) => warned.push(a.join(' '));
      let allowed = null;
      try { allowed = assertCleanWorktree({ allowDirty: true, root: base }); } finally { console.warn = original; }
      assert.equal(allowed.ok, true, '--allow-dirty 要放行');
      assert.equal(allowed.clean, false, '但要如实报告它不干净');
      assert.equal(warned.length, 2, '两条风险提示');
      assert.ok(warned.some((w) => /tag/.test(w)) && warned.some((w) => /对不上/.test(w)), '提示里要写明「与 tag 对不上」这个后果');

      // 已暂存也算脏（staged 与工作区一样会和 tag 分家）。
      fs.rmSync(path.join(base, 'untracked.txt'));
      childProcess.spawnSync('git', ['add', 'a.txt'], { cwd: base });
      fs.writeFileSync(path.join(base, 'a.txt'), 'one\n');
      assert.equal(worktreeStatus(base).clean, false, '暂存区有改动也算脏');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });

  test('真的跑一次脚本：本仓库脏时命令行必须 ✖ + 退出码 1，干净时才明说「工作区干净」', async () => {
    // 对着**本仓库**跑一次真脚本（不是拷贝到别处：脚本的 import 指向仓库里的 shared/ / server/ / tools/，
    // 拷出去就 import 不到，那测的就不是这个脚本）。两个方向都断言，所以与仓库此刻干不干净无关：
    //   · 脏 ⇒ 守卫是第一件事，必须 ✖ 且退出码 1（`--help` 除外）；
    //   · 干净 ⇒ 不许出现「拒绝出包」，而是明说一句、继续往下。
    // ⚠️ 不在这里断言「产物目录没被建出来」：干净那条路会**合法地**继续跑下去（随后在缺素材或 `--out`
    // 落在仓库里那一步失败），那时 `out` 可能已经被建出来 —— 拿它当断言只会在干净仓库上变红（本刀先写成
    // 那样，全量跑时真红了一次）。「守卫在产出之前拦下」由 `assertCleanWorktree` 的返回值与 main() 里
    // 守卫在最先这一条保证，不靠 `out` 存不存在来反推。
    const out = path.join(os.tmpdir(), `sp-guardrun-${process.pid}-${Date.now()}`);
    try {
      const isDirty = fs.existsSync(path.join(ROOT, '.git')) && childProcess
        .spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
        .stdout.trim().length > 0;
      const r = childProcess.spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'make-windows-bundle.mjs'), '--out', out, '--no-node'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      const all = `${r.stdout}${r.stderr}`;
      if (isDirty) {
        assert.equal(r.status, 1, '本仓库当前是脏的 ⇒ 守卫必须非零退出');
        assert.match(all, /拒绝出包/, '要有一句明确的拒绝');
      } else {
        assert.doesNotMatch(all, /拒绝出包/, '干净的工作区不许报「拒绝出包」');
        assert.match(all, /工作区干净/, '干净时要明确说一句');
      }
    } finally {
      await fsp.rm(out, { recursive: true, force: true });
    }
  });
});
