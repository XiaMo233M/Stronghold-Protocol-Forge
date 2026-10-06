#!/bin/sh
# Stronghold-Protocol-Forge - install a workshop pack (.zip) from the command line (macOS / Linux).
# Docs: docs/WORKSHOP.md (分享与安装一个包). The editor's 包管理 page does exactly the same thing through the same
# functions, so a pack installed here and one installed there are byte-for-byte the same result.
#
#   ./scripts/install-workshop-pack.sh ~/Downloads/my-pack.zip
#   ./scripts/install-workshop-pack.sh ~/Downloads/my-pack.zip --force    # overwrite an existing pack
#
# Installs into the repository's workshop/ directory (one subdirectory per pack). Uninstall = delete that subdirectory.
set -eu

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js（需要 22 或更高）。Node.js not found - install Node 22/24 LTS." >&2
  echo "  https://nodejs.org/zh-cn/download   或   brew install node@22" >&2
  exit 1
fi

MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$MAJOR" -lt 22 ]; then
  echo "当前 Node.js 版本 $(node -v) 太旧，需要 22 或更高（22 / 24 LTS）。" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  cat >&2 <<'USAGE'
用法：把工坊包的 .zip 路径作为参数传进来。
Usage: pass the path of a workshop pack .zip

    ./scripts/install-workshop-pack.sh ~/Downloads/my-pack.zip
    ./scripts/install-workshop-pack.sh ~/Downloads/my-pack.zip --force

装到哪里：仓库的 workshop/ 目录（一个包一个子目录）。卸载 = 删掉那个子目录。
USAGE
  exit 2
fi

exec node tools/workshop-pack.mjs import "$@"
