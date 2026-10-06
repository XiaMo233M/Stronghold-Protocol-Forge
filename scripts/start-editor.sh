#!/usr/bin/env bash
# 工坊编辑器 · macOS / Linux start script. Docs: docs/EDITOR.md
#   scripts/start-editor.sh [--port 3400] [--workshop <dir>] …   (arguments go to tools/workshop-editor.mjs)
# Checks Node.js ≥ 22, runs `npm ci` on the first run, then starts the editor on 127.0.0.1:3311 and opens it.
# No game assets and no setup step are needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js（需要 22 或更高，22 / 24 LTS）。Node.js not found."
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  安装：brew install node@22   或   https://nodejs.org/zh-cn/download"
  else
    echo "  安装：https://nodejs.org/zh-cn/download （或发行版的包管理器 / nvm / fnm）"
  fi
  exit 1
fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"; then
  echo "Node.js $(node -v) 太旧，需要 22 或更高（22 / 24 LTS）：https://nodejs.org/zh-cn/download"
  exit 1
fi

if [ ! -f node_modules/ws/package.json ]; then
  echo "[首次运行] 正在安装依赖 npm ci …"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

echo
echo "工坊编辑器正在启动（默认只绑本机 127.0.0.1:3311，可写工坊包与 data/support.json，不要暴露到公网）。"
echo "保存后需要重启游戏服务器（scripts/start.sh）才会出现在游戏里。"
echo
exec node tools/workshop-editor.mjs --open "$@"
