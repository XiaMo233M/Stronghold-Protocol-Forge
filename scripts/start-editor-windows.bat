@echo off
rem Stronghold-Protocol-Forge - double-click to start the WORKSHOP EDITOR (Windows). Docs: docs\EDITOR.md
rem Checks Node.js, installs dependencies on the first run, then starts the editor on 127.0.0.1:3311 and opens it.
rem It needs no game assets and no setup step. Extra arguments go to tools\workshop-editor.mjs, e.g.:
rem     start-editor-windows.bat --port 3400 --workshop D:\my-packs
chcp 65001 >nul
setlocal EnableExtensions
title 工坊编辑器 - Stronghold-Protocol-Forge
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 goto :oldnode

if not exist "node_modules\ws\package.json" (
  echo [首次运行] 正在安装依赖 npm ci ...
  call npm ci --no-audit --no-fund || call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

echo.
echo 工坊编辑器正在启动（默认只绑本机 127.0.0.1:3311，可写工坊包与 data\support.json，不要暴露到公网）。
echo 保存后需要重启游戏服务器（scripts\start-windows.bat）才会出现在游戏里。
echo.
node tools\workshop-editor.mjs --open %*
if errorlevel 1 goto :fail
exit /b 0

:nonode
echo.
echo 未找到 Node.js（需要 22 或更高，22 / 24 LTS）。Node.js not found.
echo.
echo   方法一：在 PowerShell 或命令提示符中运行
echo       winget install OpenJS.NodeJS.LTS
echo   方法二：从官网下载安装包  https://nodejs.org/zh-cn/download
echo.
echo 安装完成后请关闭本窗口，再重新双击 start-editor-windows.bat。
echo.
pause
exit /b 1

:oldnode
echo.
for /f "delims=" %%v in ('node -v') do echo 当前 Node.js 版本 %%v 太旧，需要 22 或更高（22 / 24 LTS）。
echo   升级：winget upgrade OpenJS.NodeJS.LTS   或   https://nodejs.org/zh-cn/download
echo.
pause
exit /b 1

:fail
echo.
echo 编辑器启动失败，请查看上面的错误信息（端口被占用时换一个：start-editor-windows.bat --port 3400）。
echo Start failed - see the messages above.
echo.
pause
exit /b 1
