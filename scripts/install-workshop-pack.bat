@echo off
rem Stronghold-Protocol-Forge - install a workshop pack by DRAGGING its .zip onto this file (Windows).
rem Docs: docs\WORKSHOP.md (分享与安装一个包). The editor's 包管理 page does exactly the same thing through the
rem same functions, so a pack installed here and one installed there are byte-for-byte the same result.
rem Extra arguments go to tools\workshop-pack.mjs, e.g.:
rem     install-workshop-pack.bat D:\Downloads\my-pack.zip --force
chcp 65001 >nul
setlocal EnableExtensions
title 安装工坊包 - Stronghold-Protocol-Forge
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 goto :oldnode

if "%~1"=="" goto :usage

echo.
node tools\workshop-pack.mjs import %*
if errorlevel 1 goto :fail
echo.
echo 安装完成。重启游戏服务器（scripts\start-windows.bat）后，这个包才会出现在游戏里。
echo.
pause
exit /b 0

:usage
echo.
echo 用法：把工坊包的 .zip 文件拖到本文件上松开（或把路径写在后面）。
echo Usage: drag a workshop pack .zip onto this file, or pass its path.
echo.
echo     install-workshop-pack.bat D:\Downloads\my-pack.zip
echo     install-workshop-pack.bat D:\Downloads\my-pack.zip --force   （覆盖同名包）
echo.
echo 装到哪里：仓库的 workshop\ 目录（一个包一个子目录）。卸载 = 删掉那个子目录。
echo.
pause
exit /b 2

:nonode
echo.
echo 未找到 Node.js（需要 22 或更高，22 / 24 LTS）。Node.js not found.
echo.
echo   方法一：在 PowerShell 或命令提示符中运行
echo       winget install OpenJS.NodeJS.LTS
echo   方法二：从官网下载安装包  https://nodejs.org/zh-cn/download
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
echo 安装失败，请查看上面的错误信息（包已存在时加 --force，或先用编辑器 / 校验器看看这个包哪里不合格）。
echo Install failed - see the messages above.
echo.
pause
exit /b 1
